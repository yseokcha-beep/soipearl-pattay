// Owner-only inventory and paid-order dashboard. Separate from gratuity system.
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { SHIRT_NAMES, SIZES, ALLOWED_STATUSES, json } from '../lib/shirt-core.mjs';

const authOK = (request) => {
  const expected=process.env.INTEREST_ADMIN_KEY;
  const got=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  if(!expected||!got)return false;
  return timingSafeEqual(createHash('sha256').update(got).digest(),createHash('sha256').update(expected).digest());
};
const ordersStore=()=>getStore({name:'soi6-shirt-orders',consistency:'strong'});
const stockStore=()=>getStore({name:'soi6-shirt-stock',consistency:'strong'});
const stockKey=(id,size)=>`stock/${id}/${size}`;
const states=()=>SHIRT_NAMES.map(()=>Object.fromEntries(SIZES.map(x=>[x,0])));

async function readPaidOrders(){
 const {blobs}=await ordersStore().list({prefix:'order/'});
 const found=await Promise.all(blobs.slice(0,3000).map(async b=>{
   try{return await ordersStore().get(b.key,{type:'json'});}catch{return null;}
 }));
 return found.filter(x=>x&&x.paidAt&&x.paymentStatus==='paid').sort((a,b)=>String(b.paidAt).localeCompare(String(a.paidAt)));
}
async function readOverview(){
 const stock=states(),pending=states(),ordered=states();
 const store=stockStore();
 const {blobs}=await store.list({prefix:'stock/'});
 await Promise.all(blobs.map(async b=>{
   const match=/^stock\/([0-5])\/(S|M|L|XL|XXL|3XL|4XL)$/.exec(b.key);
   if(!match)return;
   const obj=await store.get(b.key,{type:'json'});
   const count=Number(obj?.quantity);
   stock[Number(match[1])][match[2]]=Number.isInteger(count)&&count>=0?count:0;
 }));
 const orders=await readPaidOrders();
 let qty=0,shirtsRevenue=0,grossCollected=0;
 for(const order of orders){
    qty+=order.lines.reduce((a,l)=>a+l.qty,0);
    shirtsRevenue+=order.subtotal;
    grossCollected+=order.total;
    for(const line of order.lines){
      ordered[line.id][line.size]+=line.qty;
      if(order.fulfillmentStatus!=='fulfilled')pending[line.id][line.size]+=line.qty;
    }
 }
 const toMake=pending.map((row,i)=>Object.fromEntries(SIZES.map(sz=>[sz,Math.max(0,row[sz]-stock[i][sz])])));
 return {names:SHIRT_NAMES,sizes:SIZES,stock,ordered,pending,toMake,
     summary:{paidOrders:orders.length,orderedShirts:qty,shirtsRevenueBaht:shirtsRevenue,grossCollectedBaht:grossCollected},
     orders:orders.slice(0,250).map(o=>({id:o.id,createdAt:o.createdAt,paidAt:o.paidAt,method:o.method,
       name:o.name,email:o.email,phone:o.phone,address:o.address,
       lines:o.lines,subtotal:o.subtotal,fee:o.fee,shipping:o.shipping,total:o.total,
       fulfillmentStatus:o.fulfillmentStatus||'paid'}))};
}
export default async function handler(request){
 if(request.method==='OPTIONS')return new Response(null,{status:405});
 if(!process.env.INTEREST_ADMIN_KEY)return json({error:'Owner secret not configured'},503);
 if(!authOK(request))return json({error:'Invalid owner password'},401);
 try{
   if(request.method==='GET')return json(await readOverview());
   if(request.method!=='POST')return json({error:'Method not allowed'},405);
   if(Number(request.headers.get('content-length'))>4096)return json({error:'Payload too large'},413);
   const p=await request.json();
   if(p?.action==='set-stock-bulk'){
      if(!Array.isArray(p.entries)||p.entries.length>42)return json({error:'Invalid stock list'},400);
      const entries=p.entries.map(row=>({id:Number(row.id),size:String(row.size||''),quantity:Number(row.quantity)}));
      if(entries.some(row=>!Number.isInteger(row.id)||row.id<0||row.id>=SHIRT_NAMES.length||!SIZES.includes(row.size)||!Number.isInteger(row.quantity)||row.quantity<0||row.quantity>100000))return json({error:'Invalid stock entry'},400);
      await Promise.all(entries.map(row=>stockStore().setJSON(stockKey(row.id,row.size),{quantity:row.quantity,updatedAt:new Date().toISOString()})));
      return json({ok:true,updated:entries.length});
   }
   if(p?.action==='set-stock'){
      const id=Number(p.id),size=String(p.size||''),quantity=Number(p.quantity);
      if(!Number.isInteger(id)||id<0||id>=SHIRT_NAMES.length||!SIZES.includes(size)||!Number.isInteger(quantity)||quantity<0||quantity>100000)return json({error:'Invalid stock entry'},400);
      await stockStore().setJSON(stockKey(id,size),{quantity,updatedAt:new Date().toISOString()});
      return json({ok:true});
   }
   if(p?.action==='set-status'){
     const id=String(p.id||''),status=String(p.status||'');
     if(!/^sh_[a-f0-9-]{36}$/.test(id)||!ALLOWED_STATUSES.has(status))return json({error:'Invalid order/status'},400);
     const key='order/'+id,store=ordersStore();
     for(let attempt=0;attempt<3;attempt++){
       const old=await store.getWithMetadata(key,{type:'json'});
       if(!old?.data || old.data.paymentStatus!=='paid')return json({error:'Paid order not found'},404);
       const changed={...old.data,fulfillmentStatus:status,updatedAt:new Date().toISOString()};
       await store.setJSON(key,changed,{onlyIfMatch:old.etag});
       const confirmed=await store.get(key,{type:'json'});
       if(confirmed?.fulfillmentStatus===status && confirmed?.updatedAt===changed.updatedAt) {
         return json({ok:true});
       }
     }
     return json({error:'Order changed. Refresh and retry.'},409);
   }
   return json({error:'Unknown operation'},400);
 }catch(e){console.error('shirt-admin',e);return json({error:'Inventory dashboard unavailable. Check function logs.'},503);}
}
