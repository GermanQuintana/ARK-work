import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, hash } from './store.js';
import { WorkAuth, READ, WRITE } from './auth.js';
import { ArkClient, type ArkConfig } from './arkClient.js';
import { createArkServer } from './tools.js';

export interface Settings {
  publicUrl: URL; arkUrl: URL; redirects: Set<string>; encryptionKey: Buffer;
  dbPath: string; allowLocalHttp?: boolean; trustProxyHops?: number;
}
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
function page(title:string, content:string) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · ARK Work</title><style>body{font:17px/1.5 system-ui;background:#edf4f4;color:#17343d;margin:0;padding:40px 20px}main{max-width:520px;margin:auto;background:white;padding:32px;border-radius:16px}h1{font-size:28px}label{display:block;margin:18px 0 5px}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #a4bdbf;border-radius:6px}button{background:#126c71;color:white;padding:14px 20px;border:0;border-radius:8px;font:inherit;width:100%;margin-top:24px}.note{font-size:14px;color:#536570}.error{color:#a12c2c}a{color:#126c71}</style><main>${content}</main></html>`;
}
export function createApp(settings:Settings, verifyArk=async(config:ArkConfig)=>new ArkClient(config).get('/empresas/findEmpresaPrincipal')) {
  for(const url of [settings.publicUrl,settings.arkUrl]) {
    const local=settings.allowLocalHttp&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash)throw new Error('HTTPS URLs without embedded credentials are required');
  }
  if(settings.publicUrl.pathname!=='/')throw new Error('PUBLIC_URL must be the HTTPS origin without a path');
  if(!settings.redirects.size)throw new Error('At least one exact OAuth redirect URI is required');
  for(const uri of settings.redirects){const url=new URL(uri);if(url.protocol!=='https:'&&!(settings.allowLocalHttp&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw new Error('OAuth redirects must use HTTPS');}
  const store=new Store(settings.dbPath,settings.encryptionKey);
  const auth=new WorkAuth(store,settings.publicUrl,settings.redirects);
  const app=createMcpExpressApp({host:'0.0.0.0',allowedHosts:[settings.publicUrl.hostname]});
  app.disable('x-powered-by');
  app.set('trust proxy',settings.trustProxyHops??false);
  app.use((_req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    if(settings.publicUrl.protocol==='https:')res.set('Strict-Transport-Security','max-age=31536000');
    next();
  });
  app.use(mcpAuthRouter({provider:auth,issuerUrl:settings.publicUrl,resourceServerUrl:auth.resource,scopesSupported:[READ,WRITE],resourceName:'ARK Work',clientRegistrationOptions:{clientSecretExpirySeconds:0}}));
  const loginLimit=rateLimit({windowMs:15*60_000,limit:15,standardHeaders:'draft-8',legacyHeaders:false});
  const getFlow=(req:Request)=>typeof req.query.flow==='string'?req.query.flow:'';
  const cookie=(req:Request)=>req.headers.cookie?.split(';').map(item=>item.trim()).find(item=>item.startsWith('ark_work_flow='))?.slice('ark_work_flow='.length)??'';
  app.get('/login',(req,res)=>{
    const flow=getFlow(req),pending=auth.pending(flow);
    if(!pending||!equal(hash(cookie(req)),pending.cookie)){res.status(400).send(page('Acceso caducado','<h1>Vuelve a conectar desde ChatGPT</h1><p>Esta solicitud no es válida o ha caducado.</p>'));return;}
    const wantsWrite=pending.params.scopes?.includes(WRITE);
    res.send(page('Conectar tu clínica',`<h1>Conectar tu clínica a ARK Work</h1><p>Vas a autorizar a ChatGPT a usar tu acceso a ARK.</p><p class="note">Destino de ARK: ${esc(settings.arkUrl.origin)}. Comprueba que este servidor es de confianza.</p><form method="post" action="/login?flow=${encodeURIComponent(flow)}"><input type="hidden" name="csrf" value="${esc(pending.csrf)}"><label>Código de empresa / clínica<input name="tenant" required maxlength="120" autocomplete="organization"></label><label>Usuario de ARK<input name="username" required maxlength="160" autocomplete="username"></label><label>Contraseña de ARK<input type="password" name="password" required maxlength="512" autocomplete="current-password"></label>${wantsWrite?'<label><input type="checkbox" name="write" value="yes"> Permitir compras, pedidos y comunicaciones, siempre con vista previa y confirmación.</label>':''}<p class="note">Las credenciales se verificarán con ARK y se guardarán cifradas en este servidor para mantener tu conexión. No se guardan historias clínicas aquí. Las consultas y los resultados que solicites se procesan en ChatGPT.</p><button>Comprobar y autorizar</button><p class="note">Puedes cancelar cerrando esta ventana. Para desconectar, revoca la conexión en ChatGPT.</p></form>`));
  });
  app.post('/login',loginLimit,express.urlencoded({extended:false,limit:'8kb'}),async(req,res)=>{
    const flow=getFlow(req),pending=auth.pending(flow);
    if(!pending||req.headers.origin!==settings.publicUrl.origin||!equal(hash(cookie(req)),pending.cookie)||typeof req.body.csrf!=='string'||!equal(req.body.csrf,pending.csrf)){res.status(403).send(page('Solicitud rechazada','<h1>Vuelve a conectar desde ChatGPT</h1>'));return;}
    const input=z.object({tenant:z.string().trim().min(1).max(120),username:z.string().trim().min(1).max(160),password:z.string().min(1).max(512)}).safeParse(req.body);
    if(!input.success){res.status(400).send(page('Datos incompletos','<h1>Completa los datos de acceso</h1>'));return;}
    try {
      const config:ArkConfig={baseUrl:settings.arkUrl.href.replace(/\/$/,''),...input.data};
      const company=await verifyArk(config) as any;
      const redirect=auth.complete(flow,config,typeof company?.nombre==='string'?company.nombre:'Clínica ARK',req.body.write==='yes');
      res.clearCookie('ark_work_flow',{path:'/login',httpOnly:true,secure:settings.publicUrl.protocol==='https:',sameSite:'lax'});
      res.redirect(redirect);
    } catch {
      res.status(401).send(page('Acceso no verificado',`<h1>No se pudo verificar el acceso</h1><p>Revisa el código de empresa, el usuario y la contraseña, y comprueba la conexión con ARK.</p><a href="/login?flow=${encodeURIComponent(flow)}">Volver a intentarlo</a>`));
    }
  });
  const bearer=requireBearerAuth({verifier:auth,requiredScopes:[READ],expectedResource:auth.resource,resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(auth.resource)});
  app.use('/mcp',(req,res,next)=>{
    if(req.headers.origin&&!['https://chatgpt.com',settings.publicUrl.origin].includes(req.headers.origin)){res.status(403).end();return;}
    next();
  },bearer,rateLimit({windowMs:60_000,limit:120,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:req=>String(req.auth?.extra?.profileId)}));
  app.post('/mcp',async(req,res)=>{
    let server:ReturnType<typeof createArkServer>|undefined;
    let transport:StreamableHTTPServerTransport|undefined;
    try {
      const profile=auth.profile(String(req.auth?.extra?.profileId));
      server=createArkServer(profile.config,req.auth!.scopes.includes(WRITE));
      server.registerTool('get_profile',{description:'Identifica el perfil de clínica de esta conexión.',inputSchema:{},outputSchema:{id:z.string(),name:z.string()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{'openai/profile':true}},async()=>{
        const value={id:profile.id,name:profile.label};
        return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};
      });
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{void transport?.close();void server?.close();});
      await server.connect(transport);
      await transport.handleRequest(req,res,req.body);
    } catch {
      if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'No se pudo completar la solicitud.'},id:null});
      await transport?.close();await server?.close();
    }
  });
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  app.get('/healthz',(_req,res)=>res.json({status:'ok',service:'ark-work',version:'0.1.0'}));
  app.get('/',(_req,res)=>res.send(page('ARK Work','<h1>ARK Work</h1><p>Conecta tu clínica con ChatGPT Work mediante un MCP remoto autenticado.</p><p>Para iniciar la conexión, añade este servidor desde Plugins de ChatGPT con la dirección HTTPS de este servicio seguida de <b>/mcp</b>.</p><p><a href="https://github.com/GermanQuintana/ARK-work">Código y documentación</a></p>')));
  app.use((_error:unknown,_req:Request,res:Response,_next:unknown)=>{if(!res.headersSent)res.status(400).json({error:'Solicitud no válida'});});
  const prune=setInterval(()=>store.prune(),3600_000);prune.unref();
  return {app,auth,store,close:()=>{clearInterval(prune);store.close();}};
}
