import { Router } from 'express';
import { scheduledIdentity } from '../admin/auth.js';
import { HttpError, withLifecycleLock } from '../store.js';
import { sweep } from '../checkout/lifecycle.js';
import type { ScheduleBinding } from '../contracts.js';
import type { EbayClient } from '../ebay/index.js';

export function jobRouter(ebay:EbayClient):Router {
 const router=Router();
 router.post('/api/scheduled/expire',async(req,res)=>{
   const taskUid=await scheduledIdentity(req);
   const result=await withLifecycleLock(async store=>{
     const schedule=await store.get<ScheduleBinding>('config','schedule');
     if(!schedule?.enabled||schedule.taskUid!==taskUid)throw new HttpError(403,'SCHEDULE_BINDING','Scheduler is not bound to this application worker');
     schedule.lastAttemptAt=new Date().toISOString();await store.put('config','schedule',schedule);
     try {
       const result=await sweep(store,ebay);
       schedule.lastSuccessAt=new Date().toISOString();schedule.lastError=result.exceptions?'Some listings need reconciliation; check the seller dashboard.':undefined;
       await store.put('config','schedule',schedule);
       // Bounded retention for OAuth nonces and global rate counters; no shopper IDs.
       await store.connection.query("DELETE FROM wc_documents WHERE collection IN ('rate','oauth') AND updated_at < UTC_TIMESTAMP() - INTERVAL 2 DAY");
       return result;
     }catch {schedule.lastError='The expiry sweep could not complete. Review app-owned listings in the seller dashboard.';await store.put('config','schedule',schedule);throw new HttpError(503,'SWEEP_FAILED','The expiry sweep needs retry');}
   });res.json({ok:true,...result});
 });
 return router;
}
