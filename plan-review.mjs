// Conservative omission detector. Candidate facts may be superseded by later mail.
// Findings require operator review; absence of findings never proves completeness.
const canonical=s=>String(s).normalize('NFKC').toLowerCase().replace(/[\s\u00a0.,]/g,'');
export function reviewPlan(draft,sources){
 const output=canonical(draft.driver_message||''),facts=new Map();
 const patterns=[
  ['weight',/\b\d+(?:[ .,\u00a0]\d{3})*(?:[.,]\d{1,2})?\s*(?:kg|kgs|kilograms?)\b/gi],
  ['ldm',/\b\d+(?:[.,]\d+)?\s*ldm\b/gi],
  ['pallets',/\b\d+\s*(?:palet\w*|pall\w*|pll)\b/gi],
  ['time',/\b(?:FIX|do|by|at|najpóźniej|deadline|latest|until|o)\s*[:=]?\s*((?:[01]?\d|2[0-3]):[0-5]\d)\b/gi],
  ['trailer_secondary',/\b(?:trailer|naczepa)\s*[:#=]?\s*[A-Z0-9][A-Z0-9-]{3,}\s*\/\s*([A-Z0-9][A-Z0-9-]{4,})\b/gi],
  ['identifier',/\b(?:reference|ref|naczepa|trailer|tin)\b\s*(?:no\.?|nr\.?)?\s*[:#=]?\s*((?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{4,})\b/gi]
 ];
 for(const source of sources.filter(s=>!s.id.startsWith('rule:')&&s.id!=='operator-context')){
  const text=String(source.text||'').split('\n').filter(line=>!/^\s*(?:date|sent|inviato|data|wysłano|from|to|subject):/i.test(line)&&!/(?:napisał|wrote):?\s*$/i.test(line)).join('\n');
  for(const [kind,re]of patterns)for(const m of text.matchAll(re)){
   const value=m[1]||m[0],key=kind+':'+canonical(value);
   if(!facts.has(key))facts.set(key,{kind,value,source_id:source.id,quote:m[0]});
  }
 }
 const findings=[...facts.values()].filter(f=>!output.includes(canonical(f.value))).slice(0,40);
 return {version:1,status:findings.length?'NEEDS_REVIEW':'NO_DETECTED_OMISSIONS',findings,candidate_facts_checked:facts.size,proves_complete:false,requires_human_review:true,limitations:['Candidate facts can be superseded by later instructions.','Address, date and conditional-instruction correctness require human review.']};
}
