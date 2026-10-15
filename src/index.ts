import { createApp } from './app.js';
const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error('Missing '+name);return value;};
const key=Buffer.from(required('WORK_ENCRYPTION_KEY'),'base64');
const proxyHops=process.env.TRUST_PROXY_HOPS?Number(process.env.TRUST_PROXY_HOPS):undefined;
if(proxyHops!==undefined&&(!Number.isInteger(proxyHops)||proxyHops<0||proxyHops>2))throw new Error('TRUST_PROXY_HOPS must be 0, 1 or 2');
const service=createApp({
  publicUrl:new URL(required('PUBLIC_URL')),
  arkUrl:new URL(process.env.ARK_BASE_URL??'https://ark.gestionveterinariaark.es/ark/rest'),
  encryptionKey:key,dbPath:process.env.WORK_DB_PATH??'./data/ark-work.sqlite',
  redirects:new Set(required('OAUTH_REDIRECT_URIS').split(',').map(x=>x.trim()).filter(Boolean)),
  trustProxyHops:proxyHops,
});
const listener=service.app.listen(Number(process.env.PORT??8787),process.env.HOST??'127.0.0.1',()=>console.log('ARK Work listening'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>listener.close(()=>{service.close();process.exit(0);}));
