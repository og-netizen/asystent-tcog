import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const exec=promisify(execFile);
export async function extractPdf(bytes,{runner=exec}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>6_000_000||bytes.length<8||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('PDF invalid or too large');
 const dir=await mkdtemp(join(tmpdir(),'tcog-pdf-')),file=join(dir,'input.pdf');
 try{
  await writeFile(file,bytes,{mode:0o600});
  const options={timeout:15000,maxBuffer:250000,env:{PATH:process.env.PATH,LC_ALL:'C'},encoding:'utf8'};
  const info=(await runner('pdfinfo',[file],options)).stdout;
  const pages=Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]);if(!Number.isInteger(pages)||pages<1||pages>30)throw Error('PDF page limit');
  if(/^Encrypted:\s+yes/im.test(info))throw Error('PDF encrypted');
  const output=(await runner('pdftotext',['-layout','-enc','UTF-8',file,'-'],options)).stdout;
  const texts=output.split('\f');if(texts.at(-1)?.trim()==='')texts.pop();
  const sparse=texts.length!==pages||texts.some(t=>t.replace(/\s/g,'').length<30);
  const tooLong=output.length>90000;const text=output.slice(0,90000);
  return {sha256:createHash('sha256').update(bytes).digest('hex'),pages,text,complete:!sparse&&!tooLong,requires_visual_review:true,warnings:[...(sparse?['sparse_or_scanned_pages_require_visual_review_or_ocr']:[]),...(tooLong?['pdf_text_truncated']:[])]};
 }catch(e){if(/^PDF /.test(e.message))throw e;throw Error('PDF extraction failed');}finally{await rm(dir,{recursive:true,force:true});}
}
