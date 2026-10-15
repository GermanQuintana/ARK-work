import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidClientMetadataError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ArkConfig } from './arkClient.js';
import { Store, opaque, hash } from './store.js';

export const READ = 'ark:read';
export const WRITE = 'ark:write';
export interface Profile { id: string; config: ArkConfig; label: string }
export interface Pending { client: OAuthClientInformationFull; params: AuthorizationParams; csrf: string; cookie: string }
interface Grant { client: string; profile: string; scopes: string[]; challenge: string; redirect: string; resource: string }
interface Family { profile: string; client: string; scopes: string[]; resource: string; expires: number; revoked: boolean }
interface Token { family: string; used?: boolean; expiresAt?: number }

export class WorkAuth implements OAuthServerProvider {
  clientsStore: OAuthRegisteredClientsStore;
  constructor(readonly store: Store, readonly origin: URL, readonly redirects: Set<string>) {
    this.clientsStore = {
      getClient: async id => store.get<OAuthClientInformationFull>('client',id),
      registerClient: async input => {
        if (!input.redirect_uris.length || input.redirect_uris.some(uri => !redirects.has(uri))) throw new InvalidClientMetadataError('Redirect URI not allowed');
        if (input.token_endpoint_auth_method && !['none','client_secret_post'].includes(input.token_endpoint_auth_method)) throw new InvalidClientMetadataError('Use none or client_secret_post');
        const client = {...input, client_id:opaque(),client_id_issued_at:Math.floor(Date.now()/1000),client_secret_expires_at:0};
        store.put('client',client.client_id,client);
        return client;
      }
    };
  }
  get resource() { return new URL('/mcp',this.origin); }
  private checkResource(resource?: URL) {
    if (!resource || resource.href !== this.resource.href) throw new InvalidTargetError('The resource must match the MCP endpoint');
  }
  private checkScopes(scopes: string[]) {
    if (!scopes.includes(READ) || scopes.some(scope => ![READ,WRITE].includes(scope))) throw new InvalidScopeError('Unsupported scopes');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.checkResource(params.resource);
    params.scopes = params.scopes?.length ? params.scopes : [READ];
    this.checkScopes(params.scopes);
    if (!this.redirects.has(params.redirectUri)) throw new InvalidClientMetadataError('Redirect not allowed');
    const flow=opaque(), cookie=opaque(), csrf=opaque();
    this.store.put('pending',hash(flow),{client,params:{...params,resource:params.resource?.href},cookie:hash(cookie),csrf},Date.now()+10*60_000);
    res.cookie('ark_work_flow',cookie,{httpOnly:true,secure:this.origin.protocol==='https:',sameSite:'lax',path:'/login',maxAge:10*60_000});
    res.redirect('/login?flow='+encodeURIComponent(flow));
  }
  pending(flow:string): Pending|undefined {
    const pending=this.store.get<any>('pending',hash(flow));
    if (pending) pending.params.resource = new URL(pending.params.resource);
    return pending;
  }
  /** Called only after ARK verifies the credentials and browser consent passes CSRF checks. */
  complete(flow:string, config:ArkConfig, label:string, allowWrite:boolean) {
    const pending=this.pending(flow);
    if(!pending) throw new InvalidGrantError('Authorization expired');
    const identity=hash(config.baseUrl+'\0'+config.tenant+'\0'+config.username);
    const existing=this.store.get<{id:string}>('identity',identity);
    const profile:Profile={id:existing?.id??opaque(),config,label};
    this.store.put('profile',profile.id,profile);
    this.store.put('identity',identity,{id:profile.id});
    const scopes=(pending.params.scopes??[READ]).filter(scope=>scope!==WRITE||allowWrite);
    const code=opaque();
    this.store.put('code',hash(code),{client:pending.client.client_id,profile:profile.id,scopes,challenge:pending.params.codeChallenge,redirect:pending.params.redirectUri,resource:this.resource.href} satisfies Grant,Date.now()+60_000);
    this.store.delete('pending',hash(flow));
    const redirect=new URL(pending.params.redirectUri);
    redirect.searchParams.set('code',code);
    if(pending.params.state) redirect.searchParams.set('state',pending.params.state);
    return redirect.href;
  }
  async challengeForAuthorizationCode(client:OAuthClientInformationFull, code:string) {
    const grant=this.store.get<Grant>('code',hash(code));
    if(!grant||grant.client!==client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return grant.challenge;
  }
  async exchangeAuthorizationCode(client:OAuthClientInformationFull, code:string, _verifier?:string, redirect?:string, resource?:URL):Promise<OAuthTokens> {
    this.checkResource(resource);
    const grant=this.store.get<Grant>('code',hash(code));
    if(!grant||grant.client!==client.client_id||grant.redirect!==redirect||grant.resource!==resource?.href) throw new InvalidGrantError('Invalid authorization code');
    this.store.delete('code',hash(code));
    const family=opaque();
    this.store.put('family',family,{profile:grant.profile,client:grant.client,scopes:grant.scopes,resource:grant.resource,expires:Date.now()+30*86400_000,revoked:false} satisfies Family,Date.now()+30*86400_000);
    return this.issue(family);
  }
  private issue(familyId:string):OAuthTokens {
    const family=this.store.get<Family>('family',familyId);
    if(!family||family.revoked) throw new InvalidGrantError('Connection expired');
    const access=opaque(),refresh=opaque();
    this.store.put('access',hash(access),{family:familyId,expiresAt:Math.floor(Date.now()/1000)+3600} satisfies Token,Date.now()+3600_000);
    this.store.put('refresh',hash(refresh),{family:familyId,used:false} satisfies Token,family.expires);
    return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:family.scopes.join(' ')};
  }
  async exchangeRefreshToken(client:OAuthClientInformationFull, refresh:string, scopes?:string[], resource?:URL):Promise<OAuthTokens> {
    this.checkResource(resource);
    const token=this.store.get<Token>('refresh',hash(refresh));
    const family=token&&this.store.get<Family>('family',token.family);
    if(!token||!family||family.revoked||family.client!==client.client_id||family.resource!==resource?.href) throw new InvalidGrantError('Invalid refresh token');
    if(token.used){this.revokeFamily(token.family);throw new InvalidGrantError('Refresh token already used; connection revoked');}
    if(scopes){this.checkScopes(scopes);if(scopes.some(scope=>!family.scopes.includes(scope)))throw new InvalidScopeError('Cannot expand scopes');family.scopes=scopes;}
    this.store.put('refresh',hash(refresh),{...token,used:true},family.expires);
    this.store.put('family',token.family,family,family.expires);
    return this.issue(token.family);
  }
  async verifyAccessToken(access:string) {
    const token=this.store.get<Token>('access',hash(access));
    const family=token&&this.store.get<Family>('family',token.family);
    if(!family||family.revoked||!this.store.get<Profile>('profile',family.profile))throw new InvalidTokenError('Connection expired or revoked');
    return {token:access,clientId:family.client,scopes:family.scopes,expiresAt:token!.expiresAt,resource:new URL(family.resource),extra:{profileId:family.profile}};
  }
  profile(id:string) {
    const profile=this.store.get<Profile>('profile',id);
    if(!profile)throw new InvalidTokenError('Profile unavailable');
    return profile;
  }
  private revokeFamily(id:string) {
    const family=this.store.get<Family>('family',id);
    if(family)this.store.put('family',id,{...family,revoked:true},family.expires);
  }
  async revokeToken(client:OAuthClientInformationFull, req:OAuthTokenRevocationRequest) {
    const token=this.store.get<Token>('access',hash(req.token))??this.store.get<Token>('refresh',hash(req.token));
    const family=token&&this.store.get<Family>('family',token.family);
    if(token&&family?.client===client.client_id)this.revokeFamily(token.family);
  }
}
