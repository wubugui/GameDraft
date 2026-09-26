import zlib from 'node:zlib'; import fs from 'node:fs';
const W=64,H=64; const raw=Buffer.alloc((W*4+1)*H);
for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;for(let x=0;x<W;x++){const o=y*(W*4+1)+1+x*4;const dx=(x-31.5)/32,dy=(y-31.5)/32;const a=Math.max(0,1-Math.sqrt(dx*dx+dy*dy));raw[o]=200;raw[o+1]=180;raw[o+2]=150;raw[o+3]=Math.round(255*Math.min(1,a*1.5+0.1));}}
const crcT=new Int32Array(256).map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c;});
const crc=(b)=>{let c=-1;for(const x of b)c=crcT[(c^x)&255]^(c>>>8);return (c^-1)>>>0;};
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=6;
fs.writeFileSync('fake.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
