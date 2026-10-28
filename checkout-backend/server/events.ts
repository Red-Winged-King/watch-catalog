import type { Store } from './store.js';
export const EVENT_TYPES = new Set(['catalog_view','product_view','add_to_bag','remove_from_bag','bag_view','quote_success','quote_failure','handoff','expiry','retry']);
export async function recordEvent(store: Store, type: string): Promise<void> {
  if (!EVENT_TYPES.has(type)) return;
  const day = new Date().toISOString().slice(0,10);
  const key = `${day}:${type}`;
  const current = await store.get<{day:string;type:string;count:number}>('events',key);
  await store.put('events',key,{day,type,count:(current?.count || 0)+1});
}
