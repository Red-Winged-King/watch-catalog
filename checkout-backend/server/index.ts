import express from 'express';
import { resolve } from 'node:path';
import { authRouter, allowedOrigins } from './admin/auth.js';
import { adminRouter } from './admin/routes.js';
import { publicRouter } from './checkout/routes.js';
import { jobRouter } from './jobs/routes.js';
import { EbayClient } from './ebay/index.js';
import { withStore, HttpError } from './store.js';
import type { SellerConnection } from './contracts.js';

const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  if(req.path.startsWith('/api/')||req.path.startsWith('/auth/'))res.setHeader('Cache-Control','private, no-store');
  const origin=req.get('Origin');
  if(origin && allowedOrigins().has(origin)){
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-CSRF-Token');res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');
  }
  if(req.method==='OPTIONS'){res.status(origin&&allowedOrigins().has(origin)?204:403).end();return;}
  next();
});
app.use(express.json({limit:'2mb'}));
let dbReady=false;
app.get('/health',async(_req,res)=>{
  try {dbReady=await withStore(async store=>{const [rows]=await store.connection.query<import('mysql2/promise').RowDataPacket[]>('SELECT version FROM wc_migrations WHERE version = ?', ['001_documents']);await store.connection.query('SELECT name FROM wc_documents LIMIT 1');return rows.length===1;});}catch{dbReady=false;}
  res.status(dbReady?200:503).json({status:dbReady?'ok':'database_setup_required',service:'watch-catalog-checkout',mode:'live-gated'});
});
const ebay=new EbayClient(()=>withStore(store=>store.get<SellerConnection>('config','seller')));
app.use(authRouter);app.use(publicRouter(ebay));app.use(adminRouter(ebay));app.use(jobRouter(ebay));
app.use('/api',(_req,res)=>{res.status(404).json({code:'NOT_FOUND',error:'API route not found'});});
app.use(express.static(resolve('public'),{setHeaders:(res,path)=>{if(/\.(js|css|json|html)$/.test(path))res.setHeader('Cache-Control','no-cache');}}));
app.use((_req,res)=>{res.status(404).type('text').send('Page not found');});
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(error instanceof HttpError){res.status(error.status).json({code:error.code,error:error.message,details:error.details});return;}
  if(error instanceof SyntaxError){res.status(400).json({code:'INVALID_JSON',error:'Request JSON could not be read'});return;}
  if(error && typeof error==='object' && 'issues' in error){res.status(422).json({code:'VALIDATION',error:'One or more fields are invalid. Check the import schema and required confirmations.',details:(error as {issues:unknown}).issues});return;}
  // Validation/domain errors may have private product cost details. Return only known
  // commerce messages, never provider bodies, stack traces, token data or SQL strings.
  const message=error instanceof Error?error.message:'';
  const safe=/^(Commerce validation failed:|Cart|Product|Reference|Sold|Shipping|Settings|Invalid|Unsupported|Missing|No |SKU|All |Bundle|Price|Accessory|Supplier|Exact|Combined|Duplicate|Image|Quantity|Stock|Watch|eBay|The selected|Condition)/i.test(message)&&message.length<400;
  res.status(safe?422:503).json({code:safe?'VALIDATION':'UNAVAILABLE',error:safe?message:'This operation could not be completed. Your selection is retained; retry or contact the seller.'});
});
const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log(`Watch catalog checkout listening on ${port}; real eBay publishing remains approval-gated.`));
