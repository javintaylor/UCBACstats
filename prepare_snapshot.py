#!/usr/bin/env python3
"""Create a review-only public source snapshot; never writes to Apps Script."""
import argparse, hashlib, json, re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('capture');p.add_argument('destination');a=p.parse_args()
src=Path(a.capture);dst=Path(a.destination);dst.mkdir(parents=True,exist_ok=True)
def remove_array(text,key):
 m=re.search(r'\b'+key+r'\s*:\s*\[',text)
 if not m:return text
 start=m.end()-1;depth=0;quote=None;escape=False
 for i in range(start,len(text)):
  c=text[i]
  if quote:
   if escape:escape=False
   elif c=='\\':escape=True
   elif c==quote:quote=None
  elif c in "'\"`":quote=c
  elif c=='[':depth+=1
  elif c==']':
   depth-=1
   if depth==0:return text[:start]+'[] /* private dataset removed */'+text[i+1:]
 raise ValueError(key)
manifest=[]
for f in sorted(src.iterdir()):
 if f.suffix not in ('.js','.html','.json') or f.name.startswith('.'):continue
 t=f.read_text()
 if f.name=='CorrectionMail.js':t=remove_array(t,'HEAD_CONTACTS')
 if f.name=='MergeList20260921.js':
  for key in ('pairs','held'):t=remove_array(t,key)
 if f.name=='Cleanup2026.js':
  for key in ('DELETE_PLAYERS','RENAMES','ADD','SKIPPED_MERGES','WEEK3_IMPORTS'):t=remove_array(t,key)
 # Historical record commentary is unnecessary for understanding executable logic.
 if f.suffix=='.js':t=re.sub(r'/\*[\s\S]*?\*/',lambda m:'/* historical record comment removed */' if re.search(r'PLY-\d|ACC-\d',m[0]) else m[0],t)
 t=re.sub(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+','contact@example.invalid',t)
 t=re.sub(r'([\'\"])1[A-Za-z0-9_-]{29,}\1',lambda m:m[1]+'CONFIGURE_PRIVATE_RESOURCE_ID'+m[1],t)
 t=re.sub(r'PLY-[0-9][0-9-]*','PLY-EXAMPLE',t)
 t=re.sub(r'AKfy[A-Za-z0-9_-]{25,}','CONFIGURE_DEPLOYMENT_ID',t)
 if re.search(r'AIza[\w-]{20,}|gh[pousr]_[\w]{20,}|-----BEGIN .*PRIVATE KEY',t):raise ValueError('Potential embedded credential: '+f.name)
 (dst/f.name).write_text(t)
 manifest.append({'file':f.name,'bytes':len(t.encode()),'sha256':hashlib.sha256(t.encode()).hexdigest(),'sanitized':t!=f.read_text()})
(dst/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(len(manifest),'source files prepared. Human review required before upload.')
