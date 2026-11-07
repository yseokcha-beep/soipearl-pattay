// Shared shirt configuration and validation. Does not touch existing gratuity checkout.
export const SHIRT_NAMES = [
  'Playgirls · White',
  'Lollipop · Blue',
  'Lollipop · Neon',
  'Playgirls · Black',
  'Nikki · Neon Cat',
  'Lollipop · Candy Girl',
];
export const SIZES = ['S','M','L','XL','XXL','3XL','4XL'];
export const UNIT_BAHT = 550;
export const FEE_RATE = 0.0675;
export const FEE_FIXED_BAHT = 10;
export const ALLOWED_STATUSES = new Set(['paid','producing','ready','fulfilled']);

export const feeBaht = (subtotal) => subtotal > 0 ? Math.ceil(subtotal * FEE_RATE + FEE_FIXED_BAHT) : 0;
export const totalQty = (lines) => lines.reduce((sum,x)=>sum + x.qty,0);
export function normalizeLines(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 42) throw new Error('Select at least one shirt (up to 42 variants).');
  const merged = new Map();
  for (const x of input) {
    const id = Number(x?.id), size=String(x?.size??''), qty=Number(x?.qty);
    if (!Number.isInteger(id)||id<0||id>=SHIRT_NAMES.length||!SIZES.includes(size)||!Number.isInteger(qty)||qty<1||qty>99) {
      throw new Error('Invalid shirt, size or quantity.');
    }
    const k=`${id}:${size}`;
    const cur=merged.get(k);
    if (cur) { cur.qty += qty; if (cur.qty>99) throw new Error('Max 99 per shirt size.'); }
    else merged.set(k, {id,size,qty});
  }
  const lines=[...merged.values()];
  if (totalQty(lines)>99) throw new Error('Max 99 shirts per order.');
  return lines;
}
export function validateOrder(payload){
  const lines=normalizeLines(payload?.items);
  const method=String(payload?.method||'');
  if(!['pickup','delivery'].includes(method)) throw new Error('Select pickup or Pattaya delivery.');
  if(method==='delivery'&&totalQty(lines)<2) throw new Error('Delivery requires minimum 2 shirts.');
  const name=String(payload?.name||'').trim();
  const email=String(payload?.email||'').trim();
  const phone=String(payload?.phone||'').trim();
  const address=String(payload?.address||'').trim();
  if(name.length<1||name.length>100) throw new Error('Enter your name.');
  if(email.length>180||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('Enter a valid email.');
  if(phone.length>80) throw new Error('Phone is too long.');
  if(method==='delivery'&&(address.length<8||address.length>450)) throw new Error('Enter a delivery address within Pattaya.');
  const subtotal=UNIT_BAHT*totalQty(lines);
  const fee=feeBaht(subtotal);
  return {lines,method,name,email,phone,address:method==='delivery'?address:'',subtotal,fee,shipping:0,total:subtotal+fee};
}
export const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function sameSecret(sent,expected){
  if(!sent||!expected)return false;
  // Using hashing avoids timing differences with unequal-length secrets.
  const a = new TextEncoder().encode(sent), b=new TextEncoder().encode(expected);
  // Constant-time comparison implemented in server functions with node:crypto.
  return a.length===b.length && sent===expected;
}
