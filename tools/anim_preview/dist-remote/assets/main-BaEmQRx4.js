const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/webgpu-device-CHhU3JO2.js","assets/bind-group-factory-CShO56l6.js","assets/gifenc-DLhhX4iG.js","assets/chunk-B3K2TuZy.js"])))=>i.map(i=>d[i]);
import{n as e}from"./chunk-B3K2TuZy.js";import{t}from"./index-Cv1fB8Zp.js";import{f as n,g as r,i,l as a,m as o,p as s,t as c}from"./bind-group-factory-CShO56l6.js";var l=`set luma.log.level=1 (or higher) to trace rendering`,u="No matching device found. Ensure `@luma.gl/webgl` and/or `@luma.gl/webgpu` modules are imported.",d=new class e{static defaultProps={...s,type:`best-available`,adapters:void 0,waitForPageLoad:!0};stats=n;log=o;VERSION=`9.4.2`;spector;preregisteredAdapters=new Map;constructor(){if(globalThis.luma){if(globalThis.luma.VERSION!==this.VERSION)throw o.error(`Found luma.gl ${globalThis.luma.VERSION} while initialzing ${this.VERSION}`)(),o.error(`'yarn why @luma.gl/core' can help identify the source of the conflict`)(),Error(`luma.gl - multiple versions detected: see console log`);o.error(`This version of luma.gl has already been initialized`)()}o.log(1,`${this.VERSION} - ${l}`)(),globalThis.luma=this}async createDevice(t={}){let n={...e.defaultProps,...t},r=this.selectAdapter(n.type,n.adapters);if(!r)throw Error(u);return n.waitForPageLoad&&await r.pageLoaded,await r.create(n)}async attachDevice(e,t){let n=this._getTypeFromHandle(e,t.adapters),r=n&&this.selectAdapter(n,t.adapters);if(!r)throw Error(u);return await r?.attach?.(e,t)}registerAdapters(e){for(let t of e)this.preregisteredAdapters.set(t.type,t)}getSupportedAdapters(e=[]){let t=this._getAdapterMap(e);return Array.from(t).map(([,e])=>e).filter(e=>e.isSupported?.()).map(e=>e.type)}getBestAvailableAdapterType(e=[]){let t=[`webgpu`,`webgl`,`null`],n=this._getAdapterMap(e);for(let e of t)if(n.get(e)?.isSupported?.())return e;return null}selectAdapter(e,t=[]){let n=e;e===`best-available`&&(n=this.getBestAvailableAdapterType(t));let r=this._getAdapterMap(t);return n&&r.get(n)||null}enforceWebGL2(e=!0,t=[]){let n=this._getAdapterMap(t).get(`webgl`);n||o.warn(`enforceWebGL2: webgl adapter not found`)(),n?.enforceWebGL2?.(e)}setDefaultDeviceProps(t){Object.assign(e.defaultProps,t)}_getAdapterMap(e=[]){let t=new Map(this.preregisteredAdapters);for(let n of e)t.set(n.type,n);return t}_getTypeFromHandle(e,t=[]){return e instanceof WebGL2RenderingContext?`webgl`:typeof GPUDevice<`u`&&e instanceof GPUDevice||e?.queue?`webgpu`:e===null?`null`:(e instanceof WebGLRenderingContext?o.warn(`WebGL1 is not supported`,e)():o.warn(`Unknown handle type`,e)(),null)}},f=class{get pageLoaded(){return g()}},p=r()&&typeof document<`u`,m=()=>p&&document.readyState===`complete`,h=null;function g(){return h||=m()||typeof window>`u`?Promise.resolve():new Promise(e=>window.addEventListener(`load`,()=>e())),h}var _=class{constructor(){this._events=null}on(e,t,n){return this._add(e,t,n,!1)}addListener(e,t,n){return this._add(e,t,n,!1)}once(e,t,n){return this._add(e,t,n,!0)}off(e,t,n,r){return this.removeListener(e,t,n,r)}removeListener(e,t,n,r){let i=this._events?.get(e);if(!i)return this;if(!t)return this._events.delete(e),this;let a=i.filter(e=>e.fn!==t||r&&!e.once||n&&e.ctx!==n);return a.length?this._events.set(e,a):this._events.delete(e),this}removeAllListeners(e){return this._events&&(e===void 0?this._events=null:this._events.delete(e)),this}emit(e,...t){let n=this._events?.get(e);if(!n||n.length===0)return!1;let r=n.slice();for(let n of r)n.once&&this.removeListener(e,n.fn,n.ctx,!0),n.fn.apply(n.ctx,t);return!0}listenerCount(e){return this._events?.get(e)?.length??0}listeners(e){return(this._events?.get(e)??[]).map(e=>e.fn)}eventNames(){return this._events?[...this._events.keys()]:[]}_add(e,t,n,r){if(typeof t!=`function`)throw TypeError(`The listener must be a function`);this._events??=new Map;let i=this._events.get(e);return i||this._events.set(e,i=[]),i.push({fn:t,ctx:n||this,once:r}),this}},v=class e{constructor(e=0,t=0){this.x=0,this.y=0,this.x=e,this.y=t}clone(){return new e(this.x,this.y)}copyFrom(e){return this.set(e.x,e.y),this}copyTo(e){return e.set(this.x,this.y),e}equals(e){return e.x===this.x&&e.y===this.y}set(e=0,t=e){return this.x=e,this.y=t,this}toString(){return`[engine2d:Point x=${this.x} y=${this.y}]`}static get shared(){return y.x=0,y.y=0,y}},y=new v,b=class e{constructor(e,t=0,n=0){this._x=t,this._y=n,this._observer=e}clone(t){return new e(t??this._observer,this._x,this._y)}set(e=0,t=e){return(this._x!==e||this._y!==t)&&(this._x=e,this._y=t,this._observer?._onUpdate(this)),this}copyFrom(e){return(this._x!==e.x||this._y!==e.y)&&(this._x=e.x,this._y=e.y,this._observer?._onUpdate(this)),this}copyTo(e){return e.set(this._x,this._y),e}equals(e){return e.x===this._x&&e.y===this._y}get x(){return this._x}set x(e){this._x!==e&&(this._x=e,this._observer?._onUpdate(this))}get y(){return this._y}set y(e){this._y!==e&&(this._y=e,this._observer?._onUpdate(this))}toString(){return`[ObservablePoint x=${this._x} y=${this._y}]`}},x=Math.PI*2,S=class e{constructor(e=1,t=0,n=0,r=1,i=0,a=0){this.array=null,this.a=e,this.b=t,this.c=n,this.d=r,this.tx=i,this.ty=a}fromArray(e){this.a=e[0],this.b=e[1],this.c=e[3],this.d=e[4],this.tx=e[2],this.ty=e[5]}set(e,t,n,r,i,a){return this.a=e,this.b=t,this.c=n,this.d=r,this.tx=i,this.ty=a,this}toArray(e,t){this.array||=new Float32Array(9);let n=t||this.array;return e?(n[0]=this.a,n[1]=this.b,n[2]=0,n[3]=this.c,n[4]=this.d,n[5]=0,n[6]=this.tx,n[7]=this.ty,n[8]=1):(n[0]=this.a,n[1]=this.c,n[2]=this.tx,n[3]=this.b,n[4]=this.d,n[5]=this.ty,n[6]=0,n[7]=0,n[8]=1),n}apply(e,t){let n=t||new v,r=e.x,i=e.y;return n.x=this.a*r+this.c*i+this.tx,n.y=this.b*r+this.d*i+this.ty,n}applyInverse(e,t){let n=t||new v,{a:r,b:i,c:a,d:o,tx:s,ty:c}=this,l=1/(r*o+a*-i),u=e.x,d=e.y;return n.x=o*l*u+-a*l*d+(c*a-s*o)*l,n.y=r*l*d+-i*l*u+(-c*r+s*i)*l,n}translate(e,t){return this.tx+=e,this.ty+=t,this}scale(e,t){return this.a*=e,this.d*=t,this.c*=e,this.b*=t,this.tx*=e,this.ty*=t,this}rotate(e){let t=Math.cos(e),n=Math.sin(e),r=this.a,i=this.c,a=this.tx;return this.a=r*t-this.b*n,this.b=r*n+this.b*t,this.c=i*t-this.d*n,this.d=i*n+this.d*t,this.tx=a*t-this.ty*n,this.ty=a*n+this.ty*t,this}append(e){let t=this.a,n=this.b,r=this.c,i=this.d;return this.a=e.a*t+e.b*r,this.b=e.a*n+e.b*i,this.c=e.c*t+e.d*r,this.d=e.c*n+e.d*i,this.tx=e.tx*t+e.ty*r+this.tx,this.ty=e.tx*n+e.ty*i+this.ty,this}appendFrom(e,t){let n=e.a,r=e.b,i=e.c,a=e.d,o=e.tx,s=e.ty,c=t.a,l=t.b,u=t.c,d=t.d;return this.a=n*c+r*u,this.b=n*l+r*d,this.c=i*c+a*u,this.d=i*l+a*d,this.tx=o*c+s*u+t.tx,this.ty=o*l+s*d+t.ty,this}setTransform(e,t,n,r,i,a,o,s,c){return this.a=Math.cos(o+c)*i,this.b=Math.sin(o+c)*i,this.c=-Math.sin(o-s)*a,this.d=Math.cos(o-s)*a,this.tx=e-(n*this.a+r*this.c),this.ty=t-(n*this.b+r*this.d),this}prepend(e){let t=this.tx;if(e.a!==1||e.b!==0||e.c!==0||e.d!==1){let t=this.a,n=this.c;this.a=t*e.a+this.b*e.c,this.b=t*e.b+this.b*e.d,this.c=n*e.a+this.d*e.c,this.d=n*e.b+this.d*e.d}return this.tx=t*e.a+this.ty*e.c+e.tx,this.ty=t*e.b+this.ty*e.d+e.ty,this}decompose(e){let{a:t,b:n,c:r,d:i}=this,a=e.pivot,o=-Math.atan2(-r,i),s=Math.atan2(n,t),c=Math.abs(o+s);return c<1e-5||Math.abs(x-c)<1e-5?(e.rotation=s,e.skew.x=e.skew.y=0):(e.rotation=0,e.skew.x=o,e.skew.y=s),e.scale.x=Math.sqrt(t*t+n*n),e.scale.y=Math.sqrt(r*r+i*i),e.position.x=this.tx+(a.x*t+a.y*r),e.position.y=this.ty+(a.x*n+a.y*i),e}invert(){let e=this.a,t=this.b,n=this.c,r=this.d,i=this.tx,a=e*r-t*n;return this.a=r/a,this.b=-t/a,this.c=-n/a,this.d=e/a,this.tx=(n*this.ty-r*i)/a,this.ty=-(e*this.ty-t*i)/a,this}isIdentity(){return this.a===1&&this.b===0&&this.c===0&&this.d===1&&this.tx===0&&this.ty===0}identity(){return this.a=1,this.b=0,this.c=0,this.d=1,this.tx=0,this.ty=0,this}clone(){return new e(this.a,this.b,this.c,this.d,this.tx,this.ty)}copyTo(e){return e.a=this.a,e.b=this.b,e.c=this.c,e.d=this.d,e.tx=this.tx,e.ty=this.ty,e}copyFrom(e){return this.a=e.a,this.b=e.b,this.c=e.c,this.d=e.d,this.tx=e.tx,this.ty=e.ty,this}equals(e){return e.a===this.a&&e.b===this.b&&e.c===this.c&&e.d===this.d&&e.tx===this.tx&&e.ty===this.ty}toString(){return`[engine2d:Matrix a=${this.a} b=${this.b} c=${this.c} d=${this.d} tx=${this.tx} ty=${this.ty}]`}static get IDENTITY(){return w.identity()}static get shared(){return C.identity()}},C=new S,w=new S,T=[new v,new v,new v,new v],E=class e{constructor(e=0,t=0,n=0,r=0){this.type=`rectangle`,this.x=Number(e),this.y=Number(t),this.width=Number(n),this.height=Number(r)}get left(){return this.x}get right(){return this.x+this.width}get top(){return this.y}get bottom(){return this.y+this.height}isEmpty(){return this.left===this.right||this.top===this.bottom}static get EMPTY(){return new e(0,0,0,0)}clone(){return new e(this.x,this.y,this.width,this.height)}copyFromBounds(e){return this.x=e.minX,this.y=e.minY,this.width=e.maxX-e.minX,this.height=e.maxY-e.minY,this}copyFrom(e){return this.x=e.x,this.y=e.y,this.width=e.width,this.height=e.height,this}copyTo(e){return e.copyFrom(this),e}contains(e,t){return this.width<=0||this.height<=0?!1:e>=this.x&&e<this.x+this.width&&t>=this.y&&t<this.y+this.height}strokeContains(e,t,n,r=.5){let{width:i,height:a}=this;if(i<=0||a<=0)return!1;let o=this.x,s=this.y,c=n*(1-r),l=n-c,u=o-c,d=o+i+c,f=s-c,p=s+a+c,m=o+l,h=o+i-l,g=s+l,_=s+a-l;return e>=u&&e<=d&&t>=f&&t<=p&&!(e>m&&e<h&&t>g&&t<_)}intersects(e,t){if(!t){let t=this.x<e.x?e.x:this.x;if((this.right>e.right?e.right:this.right)<=t)return!1;let n=this.y<e.y?e.y:this.y;return(this.bottom>e.bottom?e.bottom:this.bottom)>n}let n=this.left,r=this.right,i=this.top,a=this.bottom;if(r<=n||a<=i)return!1;let o=T[0].set(e.left,e.top),s=T[1].set(e.left,e.bottom),c=T[2].set(e.right,e.top),l=T[3].set(e.right,e.bottom);if(c.x<=o.x||s.y<=o.y)return!1;let u=Math.sign(t.a*t.d-t.b*t.c);if(u===0||(t.apply(o,o),t.apply(s,s),t.apply(c,c),t.apply(l,l),Math.max(o.x,s.x,c.x,l.x)<=n||Math.min(o.x,s.x,c.x,l.x)>=r||Math.max(o.y,s.y,c.y,l.y)<=i||Math.min(o.y,s.y,c.y,l.y)>=a))return!1;let d=u*(s.y-o.y),f=u*(o.x-s.x),p=d*n+f*i,m=d*r+f*i,h=d*n+f*a,g=d*r+f*a;if(Math.max(p,m,h,g)<=d*o.x+f*o.y||Math.min(p,m,h,g)>=d*l.x+f*l.y)return!1;let _=u*(o.y-c.y),v=u*(c.x-o.x),y=_*n+v*i,b=_*r+v*i,x=_*n+v*a,S=_*r+v*a;return!(Math.max(y,b,x,S)<=_*o.x+v*o.y||Math.min(y,b,x,S)>=_*l.x+v*l.y)}pad(e=0,t=e){return this.x-=e,this.y-=t,this.width+=e*2,this.height+=t*2,this}fit(e){let t=Math.max(this.x,e.x),n=Math.min(this.x+this.width,e.x+e.width),r=Math.max(this.y,e.y),i=Math.min(this.y+this.height,e.y+e.height);return this.x=t,this.width=Math.max(n-t,0),this.y=r,this.height=Math.max(i-r,0),this}ceil(e=1,t=.001){let n=Math.ceil((this.x+this.width-t)*e)/e,r=Math.ceil((this.y+this.height-t)*e)/e;return this.x=Math.floor((this.x+t)*e)/e,this.y=Math.floor((this.y+t)*e)/e,this.width=n-this.x,this.height=r-this.y,this}scale(e,t=e){return this.x*=e,this.y*=t,this.width*=e,this.height*=t,this}enlarge(e){let t=Math.min(this.x,e.x),n=Math.max(this.x+this.width,e.x+e.width),r=Math.min(this.y,e.y),i=Math.max(this.y+this.height,e.y+e.height);return this.x=t,this.width=n-t,this.y=r,this.height=i-r,this}getBounds(t){let n=t||new e;return n.copyFrom(this),n}containsRect(e){if(this.width<=0||this.height<=0)return!1;let t=e.x,n=e.y,r=e.x+e.width,i=e.y+e.height;return t>=this.x&&t<this.x+this.width&&n>=this.y&&n<this.y+this.height&&r>=this.x&&r<this.x+this.width&&i>=this.y&&i<this.y+this.height}set(e,t,n,r){return this.x=e,this.y=t,this.width=n,this.height=r,this}toString(){return`[engine2d:Rectangle x=${this.x} y=${this.y} width=${this.width} height=${this.height}]`}},D=[1,1,0,-1,-1,-1,0,1,1,1,0,-1,-1,-1,0,1],O=[0,1,1,1,0,-1,-1,-1,0,1,1,1,0,-1,-1,-1],k=[0,-1,-1,-1,0,1,1,1,0,1,1,1,0,-1,-1,-1],A=[1,1,0,-1,-1,-1,0,1,-1,-1,0,1,1,1,0,-1],j=[];for(let e=0;e<16;e++){let t=[];j.push(t);for(let n=0;n<16;n++){let r=Math.sign(D[e]*D[n]+k[e]*O[n]),i=Math.sign(O[e]*D[n]+A[e]*O[n]),a=Math.sign(D[e]*k[n]+k[e]*A[n]),o=Math.sign(O[e]*k[n]+A[e]*A[n]);for(let e=0;e<16;e++)if(D[e]===r&&O[e]===i&&k[e]===a&&A[e]===o){t.push(e);break}}}var M={E:0,SE:1,S:2,SW:3,W:4,NW:5,N:6,NE:7,MIRROR_VERTICAL:8,MAIN_DIAGONAL:10,MIRROR_HORIZONTAL:12,REVERSE_DIAGONAL:14,uX:e=>D[e],uY:e=>O[e],vX:e=>k[e],vY:e=>A[e],inv:e=>e&8?e&15:-e&7,add:(e,t)=>j[e][t],isVertical:e=>(e&3)==2},N={black:0,white:16777215,red:16711680,green:32768,lime:65280,blue:255,yellow:16776960,cyan:65535,aqua:65535,magenta:16711935,fuchsia:16711935,gray:8421504,grey:8421504,silver:12632256,maroon:8388608,olive:8421376,purple:8388736,teal:32896,navy:128,orange:16753920,pink:16761035,brown:10824234,gold:16766720,transparent:0,darkgray:11119017,darkgrey:11119017,lightgray:13882323,lightgrey:13882323,dimgray:6908265,whitesmoke:16119285,gainsboro:14474460,beige:16119260,ivory:16777200,khaki:15787660,crimson:14423100,coral:16744272,tomato:16737095,salmon:16416882,tan:13808780,wheat:16113331,skyblue:8900331,steelblue:4620980,royalblue:4286945,indigo:4915330,violet:15631086,orchid:14315734,plum:14524637,chocolate:13789470,sienna:10506797,peru:13468991,darkred:9109504,darkgreen:25600,darkblue:139,lightblue:11393254,lightgreen:9498256,lightyellow:16777184,darkorange:16747520,forestgreen:2263842,seagreen:3050327},P;function ee(e){if(P===void 0)try{P=typeof document<`u`?document.createElement(`canvas`).getContext(`2d`):null}catch{P=null}if(!P)return null;P.fillStyle=`#010203`,P.fillStyle=e;let t=String(P.fillStyle);return t===`#010203`&&e.replace(/\s/g,``).toLowerCase()!==`#010203`?null:te(t,!1)}function te(e,t=!0){let n=e.trim().toLowerCase();if(n in N){let e=N[n];return[(e>>16&255)/255,(e>>8&255)/255,(e&255)/255,n===`transparent`?0:1]}let r=null;if(n.startsWith(`#`)?r=n.slice(1):n.startsWith(`0x`)?r=n.slice(2):/^[0-9a-f]{6}$|^[0-9a-f]{8}$|^[0-9a-f]{3}$/.test(n)&&(r=n),r!==null){if((r.length===3||r.length===4)&&(r=r.split(``).map(e=>e+e).join(``)),r.length===6&&(r+=`ff`),/^[0-9a-f]{8}$/.test(r)){let e=parseInt(r,16)>>>0;return[(e>>>24&255)/255,(e>>>16&255)/255,(e>>>8&255)/255,(e&255)/255]}return null}let i=/^rgba?\(\s*([^)]*)\)$/.exec(n);if(i){let e=i[1].split(/[\s,/]+/).filter(Boolean);if(e.length>=3){let t=e=>e.endsWith(`%`)?parseFloat(e)/100:parseFloat(e)/255,n=e[3]===void 0?1:e[3].endsWith(`%`)?parseFloat(e[3])/100:parseFloat(e[3]);return[t(e[0]),t(e[1]),t(e[2]),n]}}return t?ee(e):null}var ne=class e{static{this.shared=new e}static{this._temp=new e}constructor(e=16777215){this._components=new Float32Array([1,1,1,1]),this._int=16777215,this._value=16777215,this.setValue(e)}get red(){return this._components[0]}get green(){return this._components[1]}get blue(){return this._components[2]}get alpha(){return this._components[3]}get value(){return this._value}set value(e){this.setValue(e)}setValue(t){return t instanceof e?(this._value=t._value,this._components.set(t._components),this._int=t._int,this):(this._value=t,this._components.set(e.normalize(t)),this._refreshInt(),this)}setAlpha(e){return this._components[3]=re(e),this._value=null,this}toNumber(){return this._int}toBgrNumber(){let[e,t,n]=this.toUint8RgbArray();return(n<<16)+(t<<8)+e}toLittleEndianNumber(){let e=this._int;return(e>>16)+(e&65280)+((e&255)<<16)}toUint8RgbArray(e){let t=e??(this._arrayRgb??=[]),[n,r,i]=this._components;return t[0]=Math.round(n*255),t[1]=Math.round(r*255),t[2]=Math.round(i*255),t}toArray(e){let t=e??(this._arrayRgba??=[]),[n,r,i,a]=this._components;return t[0]=n,t[1]=r,t[2]=i,t[3]=a,t}toRgbArray(e){let t=e??(this._arrayRgb??=[]),[n,r,i]=this._components;return t[0]=n,t[1]=r,t[2]=i,t}toRgba(){let[e,t,n,r]=this._components;return{r:e,g:t,b:n,a:r}}toRgb(){let[e,t,n]=this._components;return{r:e,g:t,b:n}}toRgbaString(){let[e,t,n]=this.toUint8RgbArray();return`rgba(${e},${t},${n},${this.alpha})`}toHex(){let e=this._int.toString(16);return`#${`000000`.substring(0,6-e.length)+e}`}toHexa(){let e=Math.round(this._components[3]*255).toString(16);return this.toHex()+`00`.substring(0,2-e.length)+e}multiply(t){let[n,r,i,a]=e._temp.setValue(t)._components;return this._components[0]*=n,this._components[1]*=r,this._components[2]*=i,this._components[3]*=a,this._refreshInt(),this._value=null,this}premultiply(e,t=!0){return t&&(this._components[0]*=e,this._components[1]*=e,this._components[2]*=e),this._components[3]=e,this._refreshInt(),this._value=null,this}toPremultiplied(e,t=!0){if(e===1)return(255<<24)+this._int;if(e===0)return t?0:this._int;let n=this._int>>16&255,r=this._int>>8&255,i=this._int&255;return t&&(n=n*e+.5|0,r=r*e+.5|0,i=i*e+.5|0),(e*255<<24)+(n<<16)+(r<<8)+i}_refreshInt(){let e=this._components;for(let t=0;t<4;t++)e[t]=re(e[t]);let[t,n,r]=e;this._int=(t*255<<16)+(n*255<<8)+(r*255|0)}static isColorLike(t){try{return e.normalize(t),!0}catch{return!1}}static normalize(t){if(t==null)throw Error(`[engine2d] Color: 空值`);if(t instanceof e)return[t.red,t.green,t.blue,t.alpha];if(typeof t==`number`){let e=t>>>0;return[(e>>16&255)/255,(e>>8&255)/255,(e&255)/255,1]}if(typeof t==`string`){let e=te(t);if(!e)throw Error(`[engine2d] Color: 解析不了「${t}」`);return e}if(Array.isArray(t)||t instanceof Float32Array)return[re(t[0]??0),re(t[1]??0),re(t[2]??0),re(t[3]??1)];if(t instanceof Uint8Array||t instanceof Uint8ClampedArray)return[t[0]/255,t[1]/255,t[2]/255,(t[3]??255)/255];if(typeof t==`object`&&`r`in t)return[t.r/255,t.g/255,t.b/255,t.a??1];throw Error(`[engine2d] Color: 不认识的颜色值 ${String(t)}`)}};function re(e,t=0,n=1){return Math.min(Math.max(e,t),n)}var ie=class e extends _{static{this.defaultOptions={addressMode:`clamp-to-edge`,scaleMode:`linear`}}constructor(t={}){super(),this._resourceType=`textureSampler`,this.destroyed=!1,this._maxAnisotropy=1,this._updateId=0;let n={...e.defaultOptions,...t};this.addressMode=n.addressMode,this.addressModeU=n.addressModeU??this.addressModeU,this.addressModeV=n.addressModeV??this.addressModeV,this.addressModeW=n.addressModeW??this.addressModeW,this.scaleMode=n.scaleMode,this.magFilter=n.magFilter??this.magFilter,this.minFilter=n.minFilter??this.minFilter,this.mipmapFilter=n.mipmapFilter??this.mipmapFilter,this.lodMinClamp=n.lodMinClamp,this.lodMaxClamp=n.lodMaxClamp,this.compare=n.compare,this.maxAnisotropy=n.maxAnisotropy??1}set addressMode(e){this.addressModeU=e,this.addressModeV=e,this.addressModeW=e}get addressMode(){return this.addressModeU}set wrapMode(e){this.addressMode=e}get wrapMode(){return this.addressMode}set scaleMode(e){this.magFilter=e,this.minFilter=e,this.mipmapFilter=e}get scaleMode(){return this.magFilter}set maxAnisotropy(e){this._maxAnisotropy=Math.min(e,16),this._maxAnisotropy>1&&(this.scaleMode=`linear`)}get maxAnisotropy(){return this._maxAnisotropy}_captureKey(){let e={addressModeU:this.addressModeU,addressModeV:this.addressModeV,addressModeW:this.addressModeW,magFilter:this.magFilter,minFilter:this.minFilter,mipmapFilter:this.mipmapFilter,lodMinClamp:this.lodMinClamp,lodMaxClamp:this.lodMaxClamp,compare:this.compare,maxAnisotropy:this._maxAnisotropy};return{key:`${e.addressModeU}|${e.addressModeV}|${e.addressModeW}|${e.magFilter}|${e.minFilter}|${e.mipmapFilter}|${e.lodMinClamp}|${e.lodMaxClamp}|${e.compare}|${e.maxAnisotropy}`,fields:e}}update(){this._updateId++,this.emit(`change`,this)}destroy(){this.destroyed=!0,this.emit(`destroy`,this),this.emit(`change`,this),this.removeAllListeners()}},ae=Object.create(null);function F(e=`default`){return ae[e]=(ae[e]??-1)+1,ae[e]}var oe=function(e){return e[e.INTERACTION=50]=`INTERACTION`,e[e.HIGH=25]=`HIGH`,e[e.NORMAL=0]=`NORMAL`,e[e.LOW=-25]=`LOW`,e[e.UTILITY=-50]=`UTILITY`,e}({}),se=class{constructor(e,t=null,n=0,r=!1){this.next=null,this.previous=null,this._destroyed=!1,this._fn=e,this._context=t,this.priority=n,this._once=r}match(e,t=null){return this._fn===e&&this._context===t}emit(e){this._fn&&(this._context?this._fn.call(this._context,e):this._fn(e));let t=this.next;return this._once&&this.destroy(!0),this._destroyed&&(this.next=null),t}connect(e){this.previous=e,e.next&&(e.next.previous=this),this.next=e.next,e.next=this}destroy(e=!1){this._destroyed=!0,this._fn=null,this._context=null,this.previous&&(this.previous.next=this.next),this.next&&(this.next.previous=this.previous);let t=this.next;return this.next=e?null:t,this.previous=null,t}},ce=class e{static{this.targetFPMS=.06}constructor(){this.autoStart=!1,this.deltaTime=1,this.lastTime=-1,this.speed=1,this.started=!1,this._requestId=null,this._maxElapsedMS=100,this._minElapsedMS=0,this._protected=!1,this._lastFrame=-1,this._head=new se(null,null,1/0),this.deltaMS=1/e.targetFPMS,this.elapsedMS=1/e.targetFPMS,this._tick=e=>{this._requestId=null,this.started&&(this.update(e),this.started&&this._requestId===null&&this._head?.next&&(this._requestId=requestAnimationFrame(this._tick)))}}_requestIfNeeded(){this._requestId===null&&this._head?.next&&(this.lastTime=performance.now(),this._lastFrame=this.lastTime,this._requestId=requestAnimationFrame(this._tick))}_cancelIfNeeded(){this._requestId!==null&&(cancelAnimationFrame(this._requestId),this._requestId=null)}_startIfPossible(){this.started?this._requestIfNeeded():this.autoStart&&this.start()}add(e,t,n=oe.NORMAL){return this._addListener(new se(e,t??null,n))}addOnce(e,t,n=oe.NORMAL){return this._addListener(new se(e,t??null,n,!0))}_addListener(e){let t=this._head.next,n=this._head;if(!t)e.connect(n);else{for(;t;){if(e.priority>t.priority){e.connect(n);break}n=t,t=t.next}e.previous||e.connect(n)}return this._startIfPossible(),this}remove(e,t){let n=this._head.next;for(;n;)n=n.match(e,t??null)?n.destroy():n.next;return this._head.next||this._cancelIfNeeded(),this}get count(){if(!this._head)return 0;let e=0,t=this._head;for(;t=t.next;)e++;return e}start(){this.started||(this.started=!0,this._requestIfNeeded())}stop(){this.started&&(this.started=!1,this._cancelIfNeeded())}destroy(){if(this._protected)return;this.stop();let e=this._head.next;for(;e;)e=e.destroy(!0);this._head.destroy(),this._head=null}update(t=performance.now()){let n;if(t>this.lastTime){if(n=this.elapsedMS=t-this.lastTime,n>this._maxElapsedMS&&(n=this._maxElapsedMS),n*=this.speed,this._minElapsedMS){let e=t-this._lastFrame|0;if(e<this._minElapsedMS)return;this._lastFrame=t-e%this._minElapsedMS}this.deltaMS=n,this.deltaTime=this.deltaMS*e.targetFPMS;let r=this._head,i=r.next;for(;i;)i=i.emit(this);r.next||this._cancelIfNeeded()}else this.deltaTime=this.deltaMS=this.elapsedMS=0;this.lastTime=t}get FPS(){return 1e3/this.elapsedMS}get minFPS(){return 1e3/this._maxElapsedMS}set minFPS(t){this._maxElapsedMS=1/Math.min(Math.max(0,t)/1e3,e.targetFPMS),this._minElapsedMS&&t>this.maxFPS&&(this.maxFPS=t)}get maxFPS(){return this._minElapsedMS?Math.round(1e3/this._minElapsedMS):0}set maxFPS(e){e===0?this._minElapsedMS=0:(e<this.minFPS&&(this.minFPS=e),this._minElapsedMS=1/(e/1e3))}static get shared(){if(!e._shared){let t=e._shared=new e;t.autoStart=!0,t._protected=!0}return e._shared}static get system(){if(!e._system){let t=e._system=new e;t.autoStart=!0,t._protected=!0}return e._system}},le=class e extends _{static{this.defaultOptions={resolution:1,format:`bgra8unorm`,alphaMode:`premultiply-alpha-on-upload`,mipLevelCount:1,autoGenerateMipmaps:!1,antialias:!1,autoGarbageCollect:!1}}constructor(t={}){super(),this.uid=F(`textureSource`),this._resourceType=`textureSource`,this.uploadMethodId=`unknown`,this.pixelWidth=1,this.pixelHeight=1,this.width=1,this.height=1,this.isPowerOfTwo=!1,this.destroyed=!1,this._updateId=0,this._resourceId=F(`resource`),this._resolution=1,this._style=null;let n={...e.defaultOptions,...t};this.label=n.label??``,this.resource=n.resource,this.autoGarbageCollect=!!n.autoGarbageCollect,this._resolution=n.resolution??1,this.pixelWidth=n.width?n.width*this._resolution:this.resource&&this.resourceWidth||1,this.pixelHeight=n.height?n.height*this._resolution:this.resource&&this.resourceHeight||1,this.width=this.pixelWidth/this._resolution,this.height=this.pixelHeight/this._resolution,this.format=n.format,this.mipLevelCount=n.mipLevelCount??1,this.autoGenerateMipmaps=!!n.autoGenerateMipmaps,this.antialias=!!n.antialias,this.alphaMode=n.alphaMode,this.style=new ie(ue(n)),this._refreshPOT()}get source(){return this}get style(){return this._style}set style(e){this._style!==e&&(this._style?.off(`change`,this._onStyleChange,this),this._style=e,this._style?.on(`change`,this._onStyleChange,this),this._onStyleChange())}get addressMode(){return this.style.addressMode}set addressMode(e){this.style.addressMode=e}get repeatMode(){return this.style.addressMode}set repeatMode(e){this.style.addressMode=e}get wrapMode(){return this.style.addressMode}set wrapMode(e){this.style.addressMode=e}get magFilter(){return this.style.magFilter}set magFilter(e){this.style.magFilter=e}get minFilter(){return this.style.minFilter}set minFilter(e){this.style.minFilter=e}get mipmapFilter(){return this.style.mipmapFilter}set mipmapFilter(e){this.style.mipmapFilter=e}get scaleMode(){return this.style.scaleMode}set scaleMode(e){this.style.scaleMode=e}get maxAnisotropy(){return this.style.maxAnisotropy}set maxAnisotropy(e){this.style.maxAnisotropy=e}get lodMinClamp(){return this.style.lodMinClamp}set lodMinClamp(e){this.style.lodMinClamp=e}get lodMaxClamp(){return this.style.lodMaxClamp}set lodMaxClamp(e){this.style.lodMaxClamp=e}get compare(){return this.style.compare}_onStyleChange(){this.emit(`styleChange`,this)}update(){if(this.resource&&this.uploadMethodId!==`buffer`){let e=this._resolution;if(this.resize(this.resourceWidth/e,this.resourceHeight/e))return}this._updateId++,this.emit(`update`,this)}destroy(){this.destroyed=!0,this.unload(),this.emit(`destroy`,this),this._style&&=(this._style.destroy(),null),this.resource=null,this.removeAllListeners()}unload(){this._resourceId=F(`resource`),this.emit(`change`,this),this.emit(`unload`,this)}get resourceWidth(){let e=this.resource;return e.naturalWidth||e.videoWidth||e.displayWidth||e.width}get resourceHeight(){let e=this.resource;return e.naturalHeight||e.videoHeight||e.displayHeight||e.height}get resolution(){return this._resolution}set resolution(e){this._resolution!==e&&(this._resolution=e,this.width=this.pixelWidth/e,this.height=this.pixelHeight/e)}resize(e,t,n){n||=this._resolution,e||=this.width,t||=this.height;let r=Math.round(e*n),i=Math.round(t*n);return this.width=r/n,this.height=i/n,this._resolution=n,this.pixelWidth===r&&this.pixelHeight===i?!1:(this.pixelWidth=r,this.pixelHeight=i,this._refreshPOT(),this._updateId++,this._resourceId=F(`resource`),this.emit(`resize`,this),this.emit(`change`,this),!0)}updateMipmaps(){this.autoGenerateMipmaps&&this.mipLevelCount>1&&this.emit(`updateMipmaps`,this)}_refreshPOT(){let e=e=>e>0&&(e&e-1)==0;this.isPowerOfTwo=e(this.pixelWidth)&&e(this.pixelHeight)}static test(e){throw Error(`Unimplemented`)}static from(t,n={}){return t instanceof e?t:fe.test(t)?new fe({...n,resource:t}):pe.test(t)?new pe({...n,resource:t}):me.test(t)?new me({...n,resource:t}):new de({...n,resource:t})}};function ue(e){let t={};for(let n of[`addressMode`,`addressModeU`,`addressModeV`,`addressModeW`,`magFilter`,`minFilter`,`mipmapFilter`,`scaleMode`,`lodMinClamp`,`lodMaxClamp`,`compare`,`maxAnisotropy`])e[n]!==void 0&&(t[n]=e[n]);return t}var de=class extends le{constructor(e){super(e),this.uploadMethodId=`image`,this.autoGarbageCollect=!0}static test(e){return typeof HTMLImageElement<`u`&&e instanceof HTMLImageElement||typeof ImageBitmap<`u`&&e instanceof ImageBitmap||typeof VideoFrame<`u`&&e instanceof VideoFrame||typeof ImageData<`u`&&e instanceof ImageData}},fe=class extends le{constructor(e){let t={...e};t.resource??=document.createElement(`canvas`);let n=t.resolution??1;t.width||(t.width=t.resource.width,t.autoDensity||(t.width/=n)),t.height||(t.height=t.resource.height,t.autoDensity||(t.height/=n)),super(t),this._context2D=null,this.uploadMethodId=`image`,this.autoDensity=!!t.autoDensity,this.transparent=!!t.transparent,this.resizeCanvas()}resizeCanvas(){let e=this.resource;this.autoDensity&&`style`in e&&(e.style.width=`${this.width}px`,e.style.height=`${this.height}px`),(e.width!==this.pixelWidth||e.height!==this.pixelHeight)&&(e.width=this.pixelWidth,e.height=this.pixelHeight)}resize(e=this.width,t=this.height,n=this._resolution){let r=super.resize(e,t,n);return r&&this.resizeCanvas(),r}get context2D(){return this._context2D??=this.resource.getContext(`2d`)}static test(e){return typeof HTMLCanvasElement<`u`&&e instanceof HTMLCanvasElement||typeof OffscreenCanvas<`u`&&e instanceof OffscreenCanvas}},pe=class e extends le{static{this.defaultOptions={...le.defaultOptions,autoLoad:!0,autoPlay:!0,updateFPS:0,crossorigin:!0,loop:!1,muted:!0,playsinline:!0,preload:!1}}static{this.MIME_TYPES={ogv:`video/ogg`,mov:`video/quicktime`,m4v:`video/mp4`}}constructor(t){super(t),this.isReady=!1,this._autoUpdate=!0,this._isConnectedToTicker=!1,this._msToNextUpdate=0,this._videoFrameRequestCallbackHandle=null,this._load=null,this._resolve=null,this._reject=null,this._preloadTimeout=void 0,this._videoFrameRequestCallback=()=>{this.updateFrame(),this.destroyed?this._videoFrameRequestCallbackHandle=null:this._videoFrameRequestCallbackHandle=this.resource.requestVideoFrameCallback(this._videoFrameRequestCallback)},this._onError=e=>{this.resource.removeEventListener(`error`,this._onError,!0),this.emit(`error`,e),this._reject&&(this._reject(e),this._reject=null,this._resolve=null)},this._onPlayStart=()=>{this.isValid||this._mediaReady(),this._configureAutoUpdate()},this._onPlayStop=()=>{this._configureAutoUpdate()},this._onSeeked=()=>{this._autoUpdate&&!this._isSourcePlaying()&&(this._msToNextUpdate=0,this.updateFrame(),this._msToNextUpdate=0)},this._onCanPlay=()=>{this.resource.removeEventListener(`canplay`,this._onCanPlay),this._mediaReady()},this._onCanPlayThrough=()=>{this.resource.removeEventListener(`canplaythrough`,this._onCanPlay),this._preloadTimeout&&=(clearTimeout(this._preloadTimeout),void 0),this._mediaReady()},this.uploadMethodId=`video`,this.options=t;let n={...e.defaultOptions,...t};this._updateFPS=n.updateFPS||0,this.autoPlay=n.autoPlay!==!1,this.alphaMode=n.alphaMode??`premultiply-alpha-on-upload`,n.autoLoad!==!1&&this.load()}updateFrame(){if(!this.destroyed){if(this._updateFPS){let e=ce.shared.elapsedMS*this.resource.playbackRate;this._msToNextUpdate=Math.floor(this._msToNextUpdate-e)}(!this._updateFPS||this._msToNextUpdate<=0)&&(this._msToNextUpdate=this._updateFPS?Math.floor(1e3/this._updateFPS):0),this.isValid&&this.update()}}get isValid(){return!!this.resource.videoWidth&&!!this.resource.videoHeight}async load(){if(this._load)return this._load;let e=this.resource,t=this.options;return(e.readyState===e.HAVE_ENOUGH_DATA||e.readyState===e.HAVE_FUTURE_DATA)&&e.width&&e.height&&(e.complete=!0),e.addEventListener(`play`,this._onPlayStart),e.addEventListener(`pause`,this._onPlayStop),e.addEventListener(`seeked`,this._onSeeked),this._isSourceReady()?this._mediaReady():(t.preload||e.addEventListener(`canplay`,this._onCanPlay),e.addEventListener(`canplaythrough`,this._onCanPlayThrough),e.addEventListener(`error`,this._onError,!0)),this.alphaMode=`premultiply-alpha-on-upload`,this._load=new Promise((n,r)=>{this.isValid?n(this):(this._resolve=n,this._reject=r,t.preloadTimeoutMs!==void 0&&(this._preloadTimeout=setTimeout(()=>{this._onError(new ErrorEvent(`Preload exceeded timeout of ${t.preloadTimeoutMs}ms`))})),e.load())}),this._load}_isSourcePlaying(){let e=this.resource;return!e.paused&&!e.ended}_isSourceReady(){return this.resource.readyState>2}_mediaReady(){let e=this.resource;this.isValid&&(this.isReady=!0,this.resize(e.videoWidth,e.videoHeight)),this._msToNextUpdate=0,this.updateFrame(),this._msToNextUpdate=0,this._resolve&&(this._resolve(this),this._resolve=null,this._reject=null),this._isSourcePlaying()?this._onPlayStart():this.autoPlay&&this.resource.play()}destroy(){this._configureAutoUpdate(),this._isConnectedToTicker&&=(ce.shared.remove(this.updateFrame,this),!1);let e=this.resource;e&&(e.removeEventListener(`play`,this._onPlayStart),e.removeEventListener(`pause`,this._onPlayStop),e.removeEventListener(`seeked`,this._onSeeked),e.removeEventListener(`canplay`,this._onCanPlay),e.removeEventListener(`canplaythrough`,this._onCanPlayThrough),e.removeEventListener(`error`,this._onError,!0),e.pause(),e.src=``,e.load()),super.destroy()}get autoUpdate(){return this._autoUpdate}set autoUpdate(e){e!==this._autoUpdate&&(this._autoUpdate=e,this._configureAutoUpdate())}get updateFPS(){return this._updateFPS}set updateFPS(e){e!==this._updateFPS&&(this._updateFPS=e,this._configureAutoUpdate())}_configureAutoUpdate(){let e=this.resource;this._autoUpdate&&this._isSourcePlaying()?!this._updateFPS&&e.requestVideoFrameCallback?(this._isConnectedToTicker&&(ce.shared.remove(this.updateFrame,this),this._isConnectedToTicker=!1,this._msToNextUpdate=0),this._videoFrameRequestCallbackHandle===null&&(this._videoFrameRequestCallbackHandle=e.requestVideoFrameCallback(this._videoFrameRequestCallback))):(this._videoFrameRequestCallbackHandle!==null&&(e.cancelVideoFrameCallback(this._videoFrameRequestCallbackHandle),this._videoFrameRequestCallbackHandle=null),this._isConnectedToTicker||(ce.shared.add(this.updateFrame,this),this._isConnectedToTicker=!0,this._msToNextUpdate=0)):(this._videoFrameRequestCallbackHandle!==null&&(e.cancelVideoFrameCallback(this._videoFrameRequestCallbackHandle),this._videoFrameRequestCallbackHandle=null),this._isConnectedToTicker&&(ce.shared.remove(this.updateFrame,this),this._isConnectedToTicker=!1,this._msToNextUpdate=0))}static test(e){return typeof HTMLVideoElement<`u`&&e instanceof HTMLVideoElement}},me=class extends le{constructor(e){let t=e.resource??new Float32Array((e.width??1)*(e.height??1)*4),n=e.format;n||=t instanceof Float32Array?`rgba32float`:t instanceof Int32Array||t instanceof Uint32Array?`rgba32uint`:t instanceof Int16Array||t instanceof Uint16Array?`rgba16uint`:`bgra8unorm`,super({...e,resource:t,format:n}),this.uploadMethodId=`buffer`}static test(e){return ArrayBuffer.isView(e)&&!(e instanceof DataView)}},he=new S,ge=class{constructor(e,t){this.mapCoord=new S,this.uClampFrame=new Float32Array(4),this.uClampOffset=new Float32Array(2),this.clampOffset=0,this.isSimple=!1,this._updateID=0,this.clampMargin=t??(e.width<10?0:.5),this.texture=e}get texture(){return this._texture}set texture(e){this._texture!==e&&(this._texture?.removeListener(`update`,this.update,this),this._texture=e,this._texture.addListener(`update`,this.update,this),this.update())}multiplyUvs(e,t){t??=e;let n=this.mapCoord;for(let r=0;r<e.length;r+=2){let i=e[r],a=e[r+1];t[r]=i*n.a+a*n.c+n.tx,t[r+1]=i*n.b+a*n.d+n.ty}return t}update(){let e=this._texture;this._updateID++;let t=e.uvs;this.mapCoord.set(t.x1-t.x0,t.y1-t.y0,t.x3-t.x0,t.y3-t.y0,t.x0,t.y0);let{orig:n,trim:r}=e;r&&(he.set(n.width/r.width,0,0,n.height/r.height,-r.x/r.width,-r.y/r.height),this.mapCoord.append(he));let i=e.source,a=this.uClampFrame,o=this.clampMargin/i._resolution,s=this.clampOffset/i._resolution;return a[0]=(e.frame.x+o+s)/i.width,a[1]=(e.frame.y+o+s)/i.height,a[2]=(e.frame.x+e.frame.width-o+s)/i.width,a[3]=(e.frame.y+e.frame.height-o+s)/i.height,this.uClampOffset[0]=this.clampOffset/i.pixelWidth,this.uClampOffset[1]=this.clampOffset/i.pixelHeight,this.isSimple=e.frame.width===i.width&&e.frame.height===i.height&&e.rotate===0,!0}},I=class e extends _{constructor({source:e,label:t,frame:n,orig:r,trim:i,defaultAnchor:a,defaultBorders:o,rotate:s,dynamic:c}={}){super(),this.uid=F(`texture`),this.isTexture=!0,this.uvs={x0:0,y0:0,x1:0,y1:0,x2:0,y2:0,x3:0,y3:0},this.frame=new E,this.destroyed=!1,this._textureMatrix=null,this.label=t,this.source=e?.source??new le,this.noFrame=!n,n?this.frame.copyFrom(n):(this.frame.width=this._source.width,this.frame.height=this._source.height),this.orig=r||this.frame,this.trim=i,this.rotate=s??0,this.defaultAnchor=a,this.defaultBorders=o,this.dynamic=c||!1,this.updateUvs()}get source(){return this._source}set source(e){this._source&&this._source.off(`resize`,this.update,this),this._source=e,e.on(`resize`,this.update,this),this.emit(`update`,this)}get textureMatrix(){return this._textureMatrix??=new ge(this)}get width(){return this.orig.width}get height(){return this.orig.height}updateUvs(){let{uvs:e,frame:t}=this,{width:n,height:r}=this._source,i=t.x/n,a=t.y/r,o=t.width/n,s=t.height/r,c=this.rotate;if(c){let t=o/2,n=s/2,r=i+t,l=a+n;c=M.add(c,M.NW),e.x0=r+t*M.uX(c),e.y0=l+n*M.uY(c),c=M.add(c,2),e.x1=r+t*M.uX(c),e.y1=l+n*M.uY(c),c=M.add(c,2),e.x2=r+t*M.uX(c),e.y2=l+n*M.uY(c),c=M.add(c,2),e.x3=r+t*M.uX(c),e.y3=l+n*M.uY(c)}else e.x0=i,e.y0=a,e.x1=i+o,e.y1=a,e.x2=i+o,e.y2=a+s,e.x3=i,e.y3=a+s}update(){this.noFrame&&(this.frame.width=this._source.width,this.frame.height=this._source.height),this.updateUvs(),this.emit(`update`,this)}destroy(e=!1){this._source&&(this._source.off(`resize`,this.update,this),e&&(this._source.destroy(),this._source=null)),this._textureMatrix=null,this.destroyed=!0,this.emit(`destroy`,this),this.removeAllListeners()}static from(t,n=!1){if(t instanceof e)return t;if(typeof t==`string`){let e=_e(t);if(!e)throw Error(`[engine2d] Texture.from('${t}'):缓存里没有这张纹理,先用 Assets.load 载入`);return e}return new e({source:le.from(t)})}},_e=()=>void 0;function ve(e){_e=e}I.EMPTY=new I({label:`EMPTY`,source:new le({label:`EMPTY`})}),I.EMPTY.destroy=()=>{},I.WHITE=new I({source:new me({resource:new Uint8Array([255,255,255,255]),width:1,height:1,alphaMode:`premultiply-alpha-on-upload`,label:`WHITE`}),label:`WHITE`}),I.WHITE.destroy=()=>{};var ye=class e extends I{static create(t){let{dynamic:n,...r}=t;return new e({source:new le(r),dynamic:n??!1})}resize(e,t,n){return this.source.resize(e,t,n),this}};function be(e){return e+=e===0?1:0,--e,e|=e>>>1,e|=e>>>2,e|=e>>>4,e|=e>>>8,e|=e>>>16,e+1}var xe=0,Se=new class{constructor(e={}){this.enableFullScreen=!1,this._texturePool={},this._poolKeyHash=Object.create(null),this.textureOptions=e,this.textureStyle=new ie(e)}createTexture(e,t,n,r=!1){return new I({source:new le({...this.textureOptions,width:e,height:t,resolution:1,antialias:n,autoGarbageCollect:!1,autoGenerateMipmaps:r}),label:`texturePool_${xe++}`})}getOptimalTexture(e,t,n=1,r=!1,i=!1){let a=Math.ceil(e*n-1e-6),o=Math.ceil(t*n-1e-6);a=be(a),o=be(o);let s=(a<<17)+(o<<2)+((i?1:0)<<1)+(r?1:0),c=(this._texturePool[s]??=[]).pop();c||=this.createTexture(a,o,r,i);let l=c.source;return l._resolution=n,l.width=a/n,l.height=o/n,l.pixelWidth=a,l.pixelHeight=o,c.frame.x=0,c.frame.y=0,c.frame.width=e,c.frame.height=t,c.updateUvs(),this._poolKeyHash[c.uid]=s,c}getSameSizeTexture(e,t=!1){return this.getOptimalTexture(e.width,e.height,e.source._resolution,t)}returnTexture(e,t=!1){let n=this._poolKeyHash[e.uid];t&&(e.source.style=this.textureStyle),(this._texturePool[n]??=[]).push(e)}clear(e=!0){if(e)for(let e in this._texturePool)for(let t of this._texturePool[e])t.destroy(!0);this._texturePool={}}},Ce=new S,L=class e{constructor(e=1/0,t=1/0,n=-1/0,r=-1/0){this.matrix=Ce,this.minX=e,this.minY=t,this.maxX=n,this.maxY=r}isEmpty(){return this.minX>this.maxX||this.minY>this.maxY}get rectangle(){let e=this._rectangle??=new E;return this.minX>this.maxX||this.minY>this.maxY?(e.x=0,e.y=0,e.width=0,e.height=0):e.copyFromBounds(this),e}clear(){return this.minX=1/0,this.minY=1/0,this.maxX=-1/0,this.maxY=-1/0,this.matrix=Ce,this}set(e,t,n,r){this.minX=e,this.minY=t,this.maxX=n,this.maxY=r}addFrame(e,t,n,r,i){i||=this.matrix;let{a,b:o,c:s,d:c,tx:l,ty:u}=i,{minX:d,minY:f,maxX:p,maxY:m}=this,h=a*e+s*t+l,g=o*e+c*t+u;h<d&&(d=h),g<f&&(f=g),h>p&&(p=h),g>m&&(m=g),h=a*n+s*t+l,g=o*n+c*t+u,h<d&&(d=h),g<f&&(f=g),h>p&&(p=h),g>m&&(m=g),h=a*e+s*r+l,g=o*e+c*r+u,h<d&&(d=h),g<f&&(f=g),h>p&&(p=h),g>m&&(m=g),h=a*n+s*r+l,g=o*n+c*r+u,h<d&&(d=h),g<f&&(f=g),h>p&&(p=h),g>m&&(m=g),this.minX=d,this.minY=f,this.maxX=p,this.maxY=m}addRect(e,t){this.addFrame(e.x,e.y,e.x+e.width,e.y+e.height,t)}addBounds(e,t){this.addFrame(e.minX,e.minY,e.maxX,e.maxY,t)}addBoundsMask(e){this.minX=this.minX>e.minX?this.minX:e.minX,this.minY=this.minY>e.minY?this.minY:e.minY,this.maxX=this.maxX<e.maxX?this.maxX:e.maxX,this.maxY=this.maxY<e.maxY?this.maxY:e.maxY}applyMatrix(e){let{minX:t,minY:n,maxX:r,maxY:i}=this,{a,b:o,c:s,d:c,tx:l,ty:u}=e,d=a*t+s*n+l,f=o*t+c*n+u;this.minX=d,this.minY=f,this.maxX=d,this.maxY=f;let p=(e,t)=>{d=a*e+s*t+l,f=o*e+c*t+u,this.minX=d<this.minX?d:this.minX,this.minY=f<this.minY?f:this.minY,this.maxX=d>this.maxX?d:this.maxX,this.maxY=f>this.maxY?f:this.maxY};p(r,n),p(t,i),p(r,i)}fit(e){return this.minX<e.left&&(this.minX=e.left),this.maxX>e.right&&(this.maxX=e.right),this.minY<e.top&&(this.minY=e.top),this.maxY>e.bottom&&(this.maxY=e.bottom),this}fitBounds(e,t,n,r){return this.minX<e&&(this.minX=e),this.maxX>t&&(this.maxX=t),this.minY<n&&(this.minY=n),this.maxY>r&&(this.maxY=r),this}pad(e,t=e){return this.minX-=e,this.maxX+=e,this.minY-=t,this.maxY+=t,this}ceil(){return this.minX=Math.floor(this.minX),this.minY=Math.floor(this.minY),this.maxX=Math.ceil(this.maxX),this.maxY=Math.ceil(this.maxY),this}clone(){return new e(this.minX,this.minY,this.maxX,this.maxY)}scale(e,t=e){return this.minX*=e,this.minY*=t,this.maxX*=e,this.maxY*=t,this}get x(){return this.minX}set x(e){let t=this.maxX-this.minX;this.minX=e,this.maxX=e+t}get y(){return this.minY}set y(e){let t=this.maxY-this.minY;this.minY=e,this.maxY=e+t}get width(){return this.maxX-this.minX}set width(e){this.maxX=this.minX+e}get height(){return this.maxY-this.minY}set height(e){this.maxY=this.minY+e}get left(){return this.minX}get right(){return this.maxX}get top(){return this.minY}get bottom(){return this.maxY}get isPositive(){return this.maxX-this.minX>0&&this.maxY-this.minY>0}get isValid(){return this.minX+this.minY!==1/0}addVertexData(e,t,n,r){let{minX:i,minY:a,maxX:o,maxY:s}=this;r||=this.matrix;let{a:c,b:l,c:u,d,tx:f,ty:p}=r;for(let r=t;r<n;r+=2){let t=e[r],n=e[r+1],m=c*t+u*n+f,h=l*t+d*n+p;i=m<i?m:i,a=h<a?h:a,o=m>o?m:o,s=h>s?h:s}this.minX=i,this.minY=a,this.maxX=o,this.maxY=s}containsPoint(e,t){return this.minX<=e&&this.minY<=t&&this.maxX>=e&&this.maxY>=t}copyFrom(e){return this.minX=e.minX,this.minY=e.minY,this.maxX=e.maxX,this.maxY=e.maxY,this}toString(){return`[Bounds minX=${this.minX} minY=${this.minY} maxX=${this.maxX} maxY=${this.maxY}]`}},we=class e{constructor(){this.timeScale=1,this.unscaledDeltaTime=0,this.deltaTime=0,this.frameCount=0,this.live=[],this.liveIndex=new Map,this.pendingStart=[],this.ticking=!1,this.removedDuringTick=!1}static{this.shared=new e}get liveCount(){return this.liveIndex.size}_register(e){this.liveIndex.has(e)||(this.liveIndex.set(e,this.live.length),this.live.push(e),e._started||this.pendingStart.push(e))}_unregister(e){let t=this.liveIndex.get(e);if(t!==void 0){if(this.liveIndex.delete(e),this.ticking){this.live[t]=null,this.removedDuringTick=!0;return}this.removeAt(t)}}removeAt(e){this.live.splice(e,1),this.reindex(e)}reindex(e){for(let t=e;t<this.live.length;t++)this.liveIndex.set(this.live[t],t)}compact(){let e=0,t=this.live;for(let n=0;n<t.length;n++){let r=t[n];r&&(t[e++]=r)}t.length=e,this.reindex(0),this.removedDuringTick=!1}tick(e){if(this.ticking)return;this.ticking=!0,this.unscaledDeltaTime=e,this.deltaTime=e*this.timeScale;let t=this.deltaTime;try{if(this.pendingStart.length){let e=this.pendingStart;this.pendingStart=[];for(let t of e)if(!(t._started||!t._live)&&(t._started=!0,t.start))try{t.start()}catch(e){console.error(`[engine2d] 组件 ${t.constructor.name}.start 抛错(已截住):`,e)}}let e=this.live.length,n=this.live;for(let r=0;r<e;r++){let e=n[r];if(!(!e||!e._started||!e.update))try{e.update(t)}catch(t){console.error(`[engine2d] 组件 ${e.constructor.name}.update 抛错(已截住):`,t)}}for(let r=0;r<e;r++){let e=n[r];if(!(!e||!e._started||!e.lateUpdate))try{e.lateUpdate(t)}catch(t){console.error(`[engine2d] 组件 ${e.constructor.name}.lateUpdate 抛错(已截住):`,t)}}}finally{this.ticking=!1,this.removedDuringTick&&this.compact(),this.frameCount++}}reset(){this.live.length=0,this.liveIndex.clear(),this.pendingStart=[],this.timeScale=1,this.frameCount=0}};function Te(e,t){let n=e[t];if(n)try{n.call(e)}catch(n){console.error(`[engine2d] 组件 ${e.constructor.name}.${t} 抛错(已截住):`,n)}}function Ee(e){let t=e.gameObject;if(!t||e._destroyed||t.activeInHierarchy&&!e._awoken&&(e._awoken=!0,Te(e,`awake`),e.gameObject!==t||e._destroyed))return;let n=e._enabled&&t.activeInHierarchy;n!==e._live&&(e._live=n,n?(we.shared._register(e),Te(e,`onEnable`)):(we.shared._unregister(e),Te(e,`onDisable`)))}var De=Object.freeze({inverse:!1}),Oe=180/Math.PI,ke=Math.PI/180,Ae=class{constructor(e){this.mask=e,this.kind=`mask`,this.pipe=`stencilMask`,this.priority=0,e.includeInBuild=!1,e.measurable=!1}reset(){this.mask.measurable=!0,this.mask.includeInBuild=!0}addBounds(e){Ie(this.mask,e)}addLocalBounds(e,t){Le(this.mask,e,t)}containsPoint(e,t){return t(this.mask,e)}static test(e){return e instanceof Ye}},je=class e{constructor(e){this.kind=`mask`,this.pipe=`alphaMask`,this.priority=0,this.inverse=!1,this.renderMaskToTexture=!1,e?.mask&&this.init(e.mask)}init(t){this.mask=t,this.renderMaskToTexture=!e.test(t),this.mask.renderable=this.renderMaskToTexture,this.mask.includeInBuild=!this.renderMaskToTexture,this.mask.measurable=!1}reset(){this.mask&&(this.mask.measurable=!0)}addBounds(e){this.inverse||Ie(this.mask,e)}addLocalBounds(e,t){Le(this.mask,e,t)}containsPoint(e,t){return t(this.mask,e)}static test(e){return Ne!==null&&e instanceof Ne}},Me=class{constructor(e){this.mask=e,this.kind=`mask`,this.pipe=`colorMask`,this.priority=0}static test(e){return typeof e==`number`}},Ne=null;function Pe(e){Ne=e}function Fe(e){return je.test(e)?new je({mask:e}):Me.test(e)?new Me(e):Ae.test(e)?new Ae(e):e}function Ie(e,t){let n=new L;e.measurable=!0,it(e,!1,n),e.measurable=!1,t.addBoundsMask(n)}function Le(e,t,n){let r=new L;e.measurable=!0,nt(e,r,et(e,n,new S)),e.measurable=!1,t.addBoundsMask(r)}var Re=class{constructor(){this.kind=`filters`,this.priority=1,this.filters=null}},ze=0,Be=[],Ve=new S,He=new S,Ue=new v;function We(e,t){return e.a===t.a&&e.b===t.b&&e.c===t.c&&e.d===t.d&&e.tx===t.tx&&e.ty===t.ty}function Ge(e,t){let n=e.components;for(let e=0;e<n.length;e++)t(n[e]);let r=e.children;for(let e=0;e<r.length;e++)r[e]._subtreeComponents>0&&Ge(r[e],t)}function Ke(e,t,n){let r=e._subtreeComponents;if(r>0){for(let e=t;e;e=e.parent)e._subtreeComponents-=r;for(let e=n;e;e=e.parent)e._subtreeComponents+=r;Ge(e,Ee),Ge(e,e=>{e.gameObject&&!e._destroyed&&Te(e,`onTransformParentChanged`)})}t&&qe(t),n&&qe(n)}function qe(e){let t=e.components;for(let e=0;e<t.length;e++)Te(t[e],`onTransformChildrenChanged`)}var Je=Object.freeze([]),Ye=class extends _{constructor(e={}){super(),this.uid=F(`renderable`),this.label=null,this.children=[],this.parent=null,this.destroyed=!1,this.includeInBuild=!0,this.measurable=!0,this.allowChildren=!0,this.localTransform=new S,this._position=new b(this,0,0),this._scale=null,this._pivot=null,this._origin=null,this._skew=null,this._rotation=0,this._cx=1,this._sx=0,this._cy=0,this._sy=1,this._didContainerChangeTick=0,this._didViewChangeTick=0,this._didLocalTransformChangeId=-1,this._worldTransform=null,this.localColor=16777215,this.localAlpha=1,this.localBlendMode=`inherit`,this.localDisplayStatus=7,this.groupTransform=new S,this.groupColor=16777215,this.groupAlpha=1,this.groupColorAlpha=4294967295,this.groupBlendMode=`normal`,this.globalDisplayStatus=7,this._renderTick=-1,this._renderedRelativeTransform=null,this._renderedGroupWorldTransform=null,this._renderedWorldTransform=null,this._renderGroupStructureTick=0,this._zIndex=0,this.sortDirty=!1,this.sortableChildren=!1,this.effects=[],this._maskEffect=null,this._maskOptions=De,this._filterEffect=null,this.cullable=!1,this.cullableChildren=!0,this.cullArea=null,this.eventMode=`passive`,this.hitArea=null,this.interactiveChildren=!0,this._onRender=null,this._localBoundsCache=null,this._activeSelf=!0,this._isSceneRoot=!1,this._components=null,this._subtreeComponents=0,this._worldLocalTick=-1,this._worldParent=null,this._worldParentVersion=-1,this._worldVersion=0,this._hasChangedAck=-1;let{children:t,parent:n,...r}=e;for(let[e,t]of Object.entries(r))t!==void 0&&(this[e]=t);t?.forEach(e=>this.addChild(e)),n?.addChild(this)}addChild(...e){if(e.length>1){for(let t of e)this.addChild(t);return e[0]}let t=e[0];if(t.parent===this)return this.children.splice(this.children.indexOf(t),1),this.children.push(t),this._didViewChangeTick++,this._markStructureAsChanged(),qe(this),t;let n=t.parent;return n?._removeChildQuiet(t),this.children.push(t),this.sortableChildren&&(this.sortDirty=!0),t.parent=this,this._markStructureAsChanged(),this.emit(`childAdded`,t,this,this.children.length-1),t.emit(`added`,this),this._didViewChangeTick++,t._zIndex!==0&&t.depthOfChildModified(),Ke(t,n,this),t}removeChild(...e){if(e.length>1){for(let t of e)this.removeChild(t);return e[0]}let t=e[0];return this._removeChildQuiet(t)&&Ke(t,this,null),t}_removeChildQuiet(e){let t=this.children.indexOf(e);return t<0?!1:(this._didViewChangeTick++,this.children.splice(t,1),this._markStructureAsChanged(),e.parent=null,this.emit(`childRemoved`,e,this,t),e.emit(`removed`,this),!0)}addChildAt(e,t){let{children:n}=this;if(t<0||t>n.length)throw Error(`${String(e)}addChildAt: The index ${t} supplied is out of bounds ${n.length}`);let r=e.parent===this,i=e.parent;if(e.parent){let n=e.parent.children.indexOf(e);if(r){if(n===t)return e;e.parent.children.splice(n,1)}else e.parent._removeChildQuiet(e)}return t===n.length?n.push(e):n.splice(t,0,e),e.parent=this,this.sortableChildren&&(this.sortDirty=!0),this._didViewChangeTick++,this._markStructureAsChanged(),r?(qe(this),e):(this.emit(`childAdded`,e,this,t),e.emit(`added`,this),Ke(e,i,this),e)}removeChildren(e=0,t){let n=t??this.children.length,r=n-e,i=[];if(r>0&&r<=n){for(let t=n-1;t>=e;t--){let e=this.children[t];e&&(i.push(e),e.parent=null)}this.children.splice(e,n);for(let e=0;e<i.length;++e)this.emit(`childRemoved`,i[e],this,e),i[e].emit(`removed`,this);i.length>0&&(this._didViewChangeTick++,this._markStructureAsChanged());for(let e of i)Ke(e,this,null);return i}else if(r===0&&this.children.length===0)return i;throw RangeError(`removeChildren: numeric values are outside the acceptable range.`)}removeChildAt(e){return this.removeChild(this.getChildAt(e))}getChildAt(e){if(e<0||e>=this.children.length)throw Error(`getChildAt: Index (${e}) does not exist.`);return this.children[e]}setChildIndex(e,t){if(t<0||t>=this.children.length)throw Error(`The index ${t} supplied is out of bounds ${this.children.length}`);this.getChildIndex(e),this.addChildAt(e,t)}getChildIndex(e){let t=this.children.indexOf(e);if(t===-1)throw Error(`The supplied Container must be a child of the caller`);return t}swapChildren(e,t){if(e===t)return;let n=this.getChildIndex(e),r=this.getChildIndex(t);this.children[n]=t,this.children[r]=e,this._didViewChangeTick++,this._markStructureAsChanged(),qe(this)}removeFromParent(){this.parent?.removeChild(this)}reparentChild(...e){for(let t of e)this.reparentChildAt(t,this.children.length);return e[0]}reparentChildAt(e,t){if(e.parent===this)return this.setChildIndex(e,t),e;let n=e.worldTransform.clone();e.removeFromParent(),this.addChildAt(e,t);let r=this.worldTransform.clone();return r.invert(),n.prepend(r),e.setFromMatrix(n),e}getChildByLabel(e,t=!1){for(let t of this.children)if(t.label===e||e instanceof RegExp&&t.label!==null&&e.test(t.label))return t;if(t)for(let t of this.children){let n=t.getChildByLabel(e,!0);if(n)return n}return null}getChildrenByLabel(e,t=!1,n=[]){for(let t of this.children)(t.label===e||e instanceof RegExp&&t.label!==null&&e.test(t.label))&&n.push(t);if(t)for(let t of this.children)t.getChildrenByLabel(e,!0,n);return n}get name(){return this.label??``}set name(e){this.label=e}get activeSelf(){return this._activeSelf}setActive(e){this._activeSelf!==e&&(this._activeSelf=e,this.parent?._markStructureAsChanged(),this._onUpdate(),this._didViewChangeTick++,this._subtreeComponents>0&&Ge(this,Ee),this.emit(`activeChanged`,e))}get isSceneRoot(){return this._isSceneRoot}set isSceneRoot(e){this._isSceneRoot!==e&&(this._isSceneRoot=e,this._subtreeComponents>0&&Ge(this,Ee))}get inScene(){let e=this;for(;e.parent;)e=e.parent;return e._isSceneRoot}get activeInHierarchy(){let e=this;for(;;){if(!e._activeSelf)return!1;if(!e.parent)return e._isSceneRoot;e=e.parent}}get activeInTree(){for(let e=this;e;e=e.parent)if(!e._activeSelf)return!1;return!0}get components(){return this._components??Je}addComponent(e){let t=typeof e==`function`?new e:e;if(t._destroyed)throw Error(`[engine2d] 组件 ${t.constructor.name} 已销毁,不能再挂`);if(t.gameObject)throw Error(`[engine2d] 组件 ${t.constructor.name} 已挂在别的节点上`);t.gameObject=this,(this._components??=[]).push(t);for(let e=this;e;e=e.parent)e._subtreeComponents++;return Ee(t),t}removeComponent(e){let t=this._components,n=t?t.indexOf(e):-1;if(!t||n<0)return!1;e._live&&(e._live=!1,we.shared._unregister(e),Te(e,`onDisable`)),e._destroyed=!0,e._awoken&&Te(e,`onDestroy`);let r=t.indexOf(e);r>=0&&t.splice(r,1);for(let e=this;e;e=e.parent)e._subtreeComponents--;return e.gameObject=null,!0}getComponent(e){let t=this._components;if(t){for(let n of t)if(n instanceof e)return n}return null}getComponents(e,t=[]){let n=this._components;if(n)for(let r of n)r instanceof e&&t.push(r);return t}getComponentInChildren(e,t=!1){if(!t&&!this._activeSelf)return null;let n=this.getComponent(e);if(n)return n;for(let n of this.children){if(n._subtreeComponents===0)continue;let r=n.getComponentInChildren(e,t);if(r)return r}return null}getComponentsInChildren(e,t=!1,n=[]){if(!t&&!this._activeSelf)return n;this.getComponents(e,n);for(let r of this.children)r._subtreeComponents>0&&r.getComponentsInChildren(e,t,n);return n}getComponentInParent(e,t=!1){for(let n=this;n;n=n.parent){if(!t&&!n._activeSelf)continue;let r=n.getComponent(e);if(r)return r}return null}get localPosition(){return this.position}set localPosition(e){this.position=e}get localRotation(){return this.rotation}set localRotation(e){this.rotation=e}get localScale(){return this.scale}set localScale(e){this.scale=e}get worldPosition(){return this.getGlobalPosition(new v)}set worldPosition(e){this.parent?this.parent._ensureWorld().applyInverse(e,Ue):Ue.set(e.x,e.y),this.position.set(Ue.x,Ue.y)}get worldRotation(){let e=this._ensureWorld();return Math.atan2(e.b,e.a)}set worldRotation(e){let t=e-this.worldRotation;if(t===0)return;let n=this._ensureWorld(),r=this.worldPosition,i=Math.cos(t),a=Math.sin(t),o=He.set(n.a*i-n.b*a,n.a*a+n.b*i,n.c*i-n.d*a,n.c*a+n.d*i,(n.tx-r.x)*i-(n.ty-r.y)*a+r.x,(n.tx-r.x)*a+(n.ty-r.y)*i+r.y);this._setWorldMatrix(o.clone())}get lossyScale(){let e=this._ensureWorld();return new v((e.a*e.d-e.b*e.c<0?-1:1)*Math.hypot(e.a,e.b),Math.hypot(e.c,e.d))}get localToWorldMatrix(){return this._ensureWorld().clone()}get worldToLocalMatrix(){return this._ensureWorld().clone().invert()}get hasChanged(){return this._ensureWorld(),this._hasChangedAck!==this._worldVersion}set hasChanged(e){e?this._hasChangedAck=-1:(this._ensureWorld(),this._hasChangedAck=this._worldVersion)}setParent(e,t=!0){if(e===this.parent)return;if(e&&(e===this||e.isChildOf(this)))throw Error(`[engine2d] setParent:不能挂到自己或自己的子孙下`);let n=t?this._ensureWorld().clone():null;e?e.addChild(this):this.removeFromParent(),n&&this._setWorldMatrix(n)}_setWorldMatrix(e){let t=this.parent?new S().appendFrom(e,this.parent._ensureWorld().clone().invert()):e;this._setLocalMatrix(t)}_setLocalMatrix(e){let t=e.a*e.d-e.b*e.c,n=this._scale?this._scale._x:1,r=this._scale?this._scale._y:1,i=1,a=1;t<0?r<0&&n>=0?a=-1:i=-1:n<0&&r<0&&(i=-1,a=-1);let o=i*Math.hypot(e.a,e.b),s=a*Math.hypot(e.c,e.d),c=o===0?this._rotation:Math.atan2(e.b/o,e.a/o),l=c-(s===0?c:Math.atan2(-e.c/s,e.d/s));l=Math.atan2(Math.sin(l),Math.cos(l)),Math.abs(l)<1e-12&&(l=0),(l!==0||this._skew&&(this._skew._x!==0||this._skew._y!==0))&&this.skew.set(l,0),this.rotation=c,this.scale.set(o,s);let u=this._pivot?this._pivot._x:0,d=this._pivot?this._pivot._y:0,f=this._origin?-this._origin._x:0,p=this._origin?-this._origin._y:0;this.updateLocalTransform();let m=this.localTransform;this.position.set(e.tx+(u*m.a+d*m.c)-(f*m.a+p*m.c)+f,e.ty+(u*m.b+d*m.d)-(f*m.b+p*m.d)+p)}get siblingIndex(){return this.parent?this.parent.children.indexOf(this):0}set siblingIndex(e){let t=this.parent;t&&t.setChildIndex(this,Math.max(0,Math.min(t.children.length-1,Math.trunc(e))))}setAsFirstSibling(){this.siblingIndex=0}setAsLastSibling(){this.parent&&(this.siblingIndex=this.parent.children.length-1)}get childCount(){return this.children.length}getChild(e){return this.getChildAt(e)}get root(){let e=this;for(;e.parent;)e=e.parent;return e}isChildOf(e){for(let t=this;t;t=t.parent)if(t===e)return!0;return!1}find(e){let t=this;for(let n of e.split(`/`)){if(!t)return null;if(n===``||n===`.`)continue;if(n===`..`){t=t.parent;continue}let e=null;for(let r of t.children)if(r.label===n){e=r;break}t=e}return t}get hierarchyPath(){let e=[];for(let t=this;t;t=t.parent)e.push(t.label||`#${t.uid}`);return e.reverse().join(`/`)}transformPoint(e,t=new v){return this._ensureWorld().apply(e,t)}inverseTransformPoint(e,t=new v){return this._ensureWorld().applyInverse(e,t)}transformVector(e,t=new v){let n=this._ensureWorld();return t.set(n.a*e.x+n.c*e.y,n.b*e.x+n.d*e.y),t}inverseTransformVector(e,t=new v){let n=this._ensureWorld(),r=1/(n.a*n.d-n.b*n.c);return t.set((n.d*e.x-n.c*e.y)*r,(-n.b*e.x+n.a*e.y)*r),t}transformDirection(e,t=new v){let n=this.worldRotation,r=Math.cos(n),i=Math.sin(n);return t.set(e.x*r-e.y*i,e.x*i+e.y*r),t}inverseTransformDirection(e,t=new v){let n=-this.worldRotation,r=Math.cos(n),i=Math.sin(n);return t.set(e.x*r-e.y*i,e.x*i+e.y*r),t}translate(e,t,n=`self`){let r=n===`self`?this.transformDirection({x:e,y:t},Ue):Ue.set(e,t),i=this.worldPosition;this.worldPosition={x:i.x+r.x,y:i.y+r.y}}rotate(e){this.rotation+=e}get zIndex(){return this._zIndex}set zIndex(e){this._zIndex!==e&&(this._zIndex=e,this.depthOfChildModified())}depthOfChildModified(){this.parent&&(this.parent.sortableChildren=!0,this.parent.sortDirty=!0,this.parent._markStructureAsChanged())}sortChildren(){this.sortDirty&&(this.sortDirty=!1,this.children.sort((e,t)=>e._zIndex-t._zIndex))}_onUpdate(e){e&&e===this._skew&&this._updateSkew(),this._didContainerChangeTick++}get x(){return this._position.x}set x(e){this._position.x=e}get y(){return this._position.y}set y(e){this._position.y=e}get position(){return this._position}set position(e){this._position.copyFrom(e)}get rotation(){return this._rotation}set rotation(e){this._rotation!==e&&(this._rotation=e,this._updateSkew(),this._onUpdate())}get angle(){return this.rotation*Oe}set angle(e){this.rotation=e*ke}get pivot(){return this._pivot??=new b(this,0,0)}set pivot(e){let t=this._pivot??=new b(this,0,0);typeof e==`number`?t.set(e):t.copyFrom(e)}get skew(){return this._skew??=new b(this,0,0)}set skew(e){(this._skew??=new b(this,0,0)).copyFrom(e)}get scale(){return this._scale??=new b(this,1,1)}set scale(e){let t=this._scale??=new b(this,1,1);typeof e==`string`&&(e=parseFloat(e)),typeof e==`number`?t.set(e):t.copyFrom(e)}get origin(){return this._origin??=new b(this,0,0)}set origin(e){let t=this._origin??=new b(this,0,0);typeof e==`number`?t.set(e):t.copyFrom(e)}get width(){return Math.abs(this.scale.x*this.getLocalBounds().width)}set width(e){this._setWidth(e,this.getLocalBounds().width)}get height(){return Math.abs(this.scale.y*this.getLocalBounds().height)}set height(e){this._setHeight(e,this.getLocalBounds().height)}getSize(e={width:0,height:0}){let t=this.getLocalBounds();return e.width=Math.abs(this.scale.x*t.width),e.height=Math.abs(this.scale.y*t.height),e}setSize(e,t){let n=this.getLocalBounds(),r;typeof e==`object`?(t=e.height??e.width,r=e.width):(r=e,t??=e),r!==void 0&&this._setWidth(r,n.width),t!==void 0&&this._setHeight(t,n.height)}_setWidth(e,t){let n=Math.sign(this.scale.x)||1;this.scale.x=t===0?n:e/t*n}_setHeight(e,t){let n=Math.sign(this.scale.y)||1;this.scale.y=t===0?n:e/t*n}_updateSkew(){let e=this._rotation,t=this._skew,n=t?t._x:0,r=t?t._y:0;this._cx=Math.cos(e+r),this._sx=Math.sin(e+r),this._cy=-Math.sin(e-n),this._sy=Math.cos(e-n)}updateTransform(e){return this.position.set(typeof e.x==`number`?e.x:this.position.x,typeof e.y==`number`?e.y:this.position.y),this.scale.set(typeof e.scaleX==`number`?e.scaleX||1:this.scale.x,typeof e.scaleY==`number`?e.scaleY||1:this.scale.y),this.rotation=typeof e.rotation==`number`?e.rotation:this.rotation,this.skew.set(typeof e.skewX==`number`?e.skewX:this.skew.x,typeof e.skewY==`number`?e.skewY:this.skew.y),this.pivot.set(typeof e.pivotX==`number`?e.pivotX:this.pivot.x,typeof e.pivotY==`number`?e.pivotY:this.pivot.y),this.origin.set(typeof e.originX==`number`?e.originX:this.origin.x,typeof e.originY==`number`?e.originY:this.origin.y),this}setFromMatrix(e){e.decompose(this)}updateLocalTransform(){let e=this._didContainerChangeTick;if(this._didLocalTransformChangeId===e)return;this._didLocalTransformChangeId=e;let t=this.localTransform,n=this._scale?this._scale._x:1,r=this._scale?this._scale._y:1,i=this._pivot?this._pivot._x:0,a=this._pivot?this._pivot._y:0,o=this._origin?-this._origin._x:0,s=this._origin?-this._origin._y:0,c=this._position;t.a=this._cx*n,t.b=this._sx*n,t.c=this._cy*r,t.d=this._sy*r,t.tx=c._x-(i*t.a+a*t.c)+(o*t.a+s*t.c)-o,t.ty=c._y-(i*t.b+a*t.d)+(o*t.b+s*t.d)-s}get worldTransform(){return this._ensureWorld()}getGlobalTransform(e=new S,t=!1){return e.copyFrom(this._ensureWorld())}_ensureWorld(){let e=Be,t=0;for(let n=this;n;n=n.parent)e[t++]=n;let n=null;for(let r=t-1;r>=0;r--){let t=e[r];e[r]=null,t.updateLocalTransform();let i=t._worldTransform??=new S,a=n?n._worldVersion:-1;(t._worldLocalTick!==t._didContainerChangeTick||t._worldParent!==n||t._worldParentVersion!==a)&&(t._worldLocalTick=t._didContainerChangeTick,t._worldParent=n,t._worldParentVersion=a,n?Ve.appendFrom(t.localTransform,n._worldTransform):Ve.copyFrom(t.localTransform),(t._worldVersion===0||!We(i,Ve))&&(i.copyFrom(Ve),t._worldVersion++)),n=t}return this._worldTransform}getGlobalPosition(e=new v,t=!1){return this.parent?this.parent.toGlobal(this._position,e,t):(e.x=this._position.x,e.y=this._position.y),e}toGlobal(e,t,n=!1){return this._ensureWorld().apply(e,t)}toLocal(e,t,n,r){return t&&(e=t.toGlobal(e,n,r)),this._ensureWorld().applyInverse(e,n)}getGlobalAlpha(e=!1){let t=this.alpha,n=this.parent;for(;n;)t*=n.alpha,n=n.parent;return t}getGlobalTint(e=!1){let t=this.localColor,n=this.parent;for(;n;)t=Qe(t,n.localColor),n=n.parent;return Xe(t)}get alpha(){return this.localAlpha}set alpha(e){e!==this.localAlpha&&(this.localAlpha=e,this._onUpdate())}get tint(){return Xe(this.localColor)}set tint(e){let t=ne.shared.setValue(e??16777215).toBgrNumber();t!==this.localColor&&(this.localColor=t,this._onUpdate())}get blendMode(){return this.localBlendMode}set blendMode(e){this.localBlendMode!==e&&(this.parent?._markStructureAsChanged(),this.localBlendMode=e,this._onUpdate())}get visible(){return!!(this.localDisplayStatus&2)}set visible(e){let t=e?2:0;(this.localDisplayStatus&2)!==t&&(this.parent?._markStructureAsChanged(),this.localDisplayStatus^=2,this._onUpdate(),this._didViewChangeTick++,this.emit(`visibleChanged`,e))}get culled(){return!(this.localDisplayStatus&4)}set culled(e){let t=e?0:4;(this.localDisplayStatus&4)!==t&&(this.parent?._markStructureAsChanged(),this.localDisplayStatus^=4,this._onUpdate())}get renderable(){return!!(this.localDisplayStatus&1)}set renderable(e){let t=e?1:0;(this.localDisplayStatus&1)!==t&&(this.parent?._markStructureAsChanged(),this.localDisplayStatus^=1,this._onUpdate())}get isRenderable(){return this.localDisplayStatus===7&&this.groupAlpha>0}get isRenderGroup(){return this._renderedGroupWorldTransform!==null}set isRenderGroup(e){e?this.enableRenderGroup():this.disableRenderGroup()}enableRenderGroup(){this._renderedGroupWorldTransform||(this.parent?._markStructureAsChanged(),this._renderedGroupWorldTransform=new S,this._renderGroupStructureTick++)}disableRenderGroup(){this._renderedGroupWorldTransform&&=(this.parent?._markStructureAsChanged(),null)}_markStructureAsChanged(){let e=this;for(;e&&!e.isRenderGroup;)e=e.parent;e&&e._renderGroupStructureTick++}get onRender(){return this._onRender}set onRender(e){this._onRender=e??null}get mask(){return this._maskEffect?.mask??null}set mask(e){let t=this._maskEffect;t?.mask!==e&&(t&&(this.removeEffect(t),t.reset?.(),this._maskEffect=null),e!=null&&(this._maskEffect=Fe(e),this.addEffect(this._maskEffect)))}setMask(e){this._maskOptions={...this._maskOptions,...e},e.mask&&(this.mask=e.mask),this._markStructureAsChanged()}get filters(){return this._filterEffect?.filters??null}set filters(e){let t=e==null?null:Array.isArray(e)?e.slice(0):[e],n=this._filterEffect??=new Re,r=!!t&&t.length>0,i=!!n.filters&&n.filters.length>0;t&&=Object.freeze(t),n.filters=t,r!==i&&(r?this.addEffect(n):this.removeEffect(n))}get filterArea(){return this._filterEffect?.filterArea}set filterArea(e){(this._filterEffect??=new Re).filterArea=e}addEffect(e){this.effects.includes(e)||(this.effects.push(e),this.effects.sort((e,t)=>e.priority-t.priority),this._didViewChangeTick++,this._markStructureAsChanged())}removeEffect(e){let t=this.effects.indexOf(e);t!==-1&&(this.effects.splice(t,1),this._didViewChangeTick++,this._markStructureAsChanged())}get interactive(){return this.eventMode===`dynamic`||this.eventMode===`static`}set interactive(e){this.eventMode=e?`static`:`passive`}isInteractive(){return this.eventMode===`static`||this.eventMode===`dynamic`}addEventListener(e,t,n){let r=typeof n==`boolean`&&n||typeof n==`object`&&n.capture,i=typeof n==`object`?n.signal:void 0,a=typeof n==`object`?n.once===!0:!1,o=typeof t==`function`?void 0:t,s=r?`${e}capture`:e,c=typeof t==`function`?t:t.handleEvent;i?.addEventListener(`abort`,()=>this.off(s,c,o)),a?this.once(s,c,o):this.on(s,c,o)}removeEventListener(e,t,n){let r=typeof n==`boolean`&&n||typeof n==`object`&&n.capture,i=typeof t==`function`?void 0:t,a=r?`${e}capture`:e,o=typeof t==`function`?t:t.handleEvent;this.off(a,o,i)}dispatchEvent(e){if(!e.manager)throw Error(`Container cannot propagate events outside of the Federated Events API`);return e.defaultPrevented=!1,e.path=null,e.target=this,e.manager.dispatchEvent(e),!e.defaultPrevented}get bounds(){}getLocalBounds(){let e=tt(this);if(this._localBoundsCache?.tick===e)return this._localBoundsCache.bounds;let t=this._localBoundsCache?.bounds??new L;return nt(this,t,new S),this._localBoundsCache={tick:e,bounds:t},t}getBounds(e=!1,t){return it(this,e,t??new L)}containsPoint(e){return!1}collectRenderables(e){}_prepareRenderGroup(e,t){}_validateRenderGroup(e){}static _nextRenderTick(){return++ze}destroy(e=!1){if(this.destroyed)return;if(this._components)for(let e of[...this._components])this.removeComponent(e);this.destroyed=!0;let t;if(this.children.length&&(t=this.removeChildren(0,this.children.length)),this.removeFromParent(),this.parent=null,this._maskEffect=null,this._filterEffect=null,this.effects=[],this._renderedRelativeTransform=null,this._renderedGroupWorldTransform=null,this._renderedWorldTransform=null,this.emit(`destroyed`,this),this.removeAllListeners(),(typeof e==`boolean`?e:e?.children)&&t)for(let n of t)n.destroy(e)}};function Xe(e){return((e&255)<<16)+(e&65280)+(e>>16&255)}function Ze(e,t){if(e===16777215||!t)return t;if(t===16777215||!e)return e;let n=(e>>16&255)*(t>>16&255)/255|0,r=(e>>8&255)*(t>>8&255)/255|0,i=(e&255)*(t&255)/255|0;return(n<<16)+(r<<8)+i}function Qe(e,t){return e===16777215?t:t===16777215?e:Ze(e,t)}function $e(e,t){let n=e.parent;return n&&($e(n,t),n.updateLocalTransform(),t.append(n.localTransform)),t}function et(e,t,n){return e&&e!==t&&(et(e.parent,t,n),e.updateLocalTransform(),n.append(e.localTransform)),n}function tt(e){let t=`${e._didViewChangeTick}`,n=e=>{for(let r of e.children)t+=`|${r.uid}:${r._didViewChangeTick}:${r._didContainerChangeTick}`,r.children.length&&n(r)};return n(e),t}function nt(e,t,n){return t.clear(),rt(e,t,n??S.IDENTITY,e,!0),t.isValid||t.set(0,0,0,0),t}function rt(e,t,n,r,i){let a;if(i)a=n.clone();else{if(!e._activeSelf||!e.visible||!e.measurable)return;e.updateLocalTransform(),a=new S().appendFrom(e.localTransform,n)}let o=t,s=e.effects.length>0;if(s&&(t=new L),e.boundsArea)t.addRect(e.boundsArea,a);else{let n=e.bounds;e.renderPipeId&&n&&(t.matrix=a,t.addBounds(n));for(let n of e.children)rt(n,t,a,r,!1)}if(s){for(let n of e.effects)n.addLocalBounds?.(t,r);o.addBounds(t,S.IDENTITY)}}function it(e,t,n){return n.clear(),ct(e,n,e.parent?$e(e,new S):S.IDENTITY),n.isValid||n.set(0,0,0,0),n}function at(e,t){let n=e._renderedWorldTransform??=new S;if(e._renderedGroupWorldTransform)n.copyFrom(e._renderedGroupWorldTransform);else{let t=e.parent;for(;t&&!t._renderedGroupWorldTransform;)t=t.parent;t&&n.appendFrom(e._renderedRelativeTransform??S.IDENTITY,t._renderedGroupWorldTransform)}return t.copyFrom(n)}function ot(e,t){return t.clear(),st(e,t),t.isValid||t.set(0,0,0,0),t}function st(e,t){if(!e._activeSelf||!e.visible||!e.measurable)return;let n=at(e,new S),r=t,i=e.effects.length>0;if(i&&(t=new L),e.boundsArea)t.addRect(e.boundsArea,n);else{let r=e.bounds;r&&!r.isEmpty()&&(t.matrix=n,t.addBounds(r));for(let n of e.children)st(n,t)}if(i){for(let n of e.effects)n.addBounds?.(t);r.addBounds(t,S.IDENTITY)}}function ct(e,t,n){if(!e._activeSelf||!e.visible||!e.measurable)return;e.updateLocalTransform();let r=new S().appendFrom(e.localTransform,n),i=t,a=e.effects.length>0;if(a&&(t=new L),e.boundsArea)t.addRect(e.boundsArea,r);else{let n=e.bounds;n&&!n.isEmpty()&&(t.matrix=r,t.addBounds(n));for(let n of e.children)ct(n,t,r)}if(a){for(let n of e.effects)n.addBounds?.(t);i.addBounds(t,S.IDENTITY)}}var lt=class extends Ye{constructor(e={}){super(e),this._bounds=new L(0,1,0,0),this._boundsDirty=!0,this._roundPixels=0,this._batchRoundPixels=-1,this._viewUpdateTick=0,this.allowChildren=!1}get bounds(){return this._boundsDirty?(this.updateBounds(),this._boundsDirty=!1,this._bounds):this._bounds}get roundPixels(){return!!this._roundPixels}set roundPixels(e){this._roundPixels=e?1:0}_latchRoundPixels(e){return this._batchRoundPixels<0&&(this._batchRoundPixels=(e.roundPixels??0)|this._roundPixels),this._batchRoundPixels}containsPoint(e){let t=this.bounds;return e.x>=t.minX&&e.x<=t.maxX&&e.y>=t.minY&&e.y<=t.maxY}onViewUpdate(){this._viewUpdateTick++,this._didViewChangeTick++,this._boundsDirty=!0}unload(){this.emit(`unload`,this),this._batchRoundPixels=-1,this.onViewUpdate()}destroy(e){this._batchRoundPixels=-1,super.destroy(e)}},ut=class e extends lt{constructor(e=I.EMPTY){let{texture:t=I.EMPTY,anchor:n,roundPixels:r,width:i,height:a,...o}=e instanceof I?{texture:e}:e;super({label:`Sprite`,...o}),this.renderPipeId=`sprite`,this._visualBounds={minX:0,maxX:1,minY:0,maxY:0},this._visualBoundsDirty=!0,this._batchHistory=new WeakMap,this._batchTransform=new S,this._anchor=new b({_onUpdate:()=>this.onViewUpdate()}),n?this.anchor=n:t.defaultAnchor&&(this.anchor=t.defaultAnchor),this.texture=t,this.roundPixels=r??!1,i!==void 0&&(this.width=i),a!==void 0&&(this.height=a),this._batchable={texture:this._texture,transform:this.groupTransform,color:4294967295,roundPixels:0,blendMode:`normal`,topology:`triangle-list`,packAsQuad:!0,bounds:this._visualBounds,attributeOffset:0,attributeSize:4,indexOffset:0,indexSize:6}}static from(t,n=!1){return new e(t instanceof I?t:I.from(t,n))}get texture(){return this._texture}set texture(e){e||=I.EMPTY;let t=this._texture;t!==e&&(t&&t.dynamic&&t.off(`update`,this.onViewUpdate,this),e.dynamic&&e.on(`update`,this.onViewUpdate,this),this._texture=e,this._width&&this._setWidth(this._width,e.orig.width),this._height&&this._setHeight(this._height,e.orig.height),this.onViewUpdate())}get anchor(){return this._anchor}set anchor(e){typeof e==`number`?this._anchor.set(e):this._anchor.copyFrom(e)}get visualBounds(){return dt(this._visualBounds,this._anchor,this._texture),this._visualBounds}onViewUpdate(){super.onViewUpdate(),this._visualBoundsDirty=!0}updateBounds(){let{width:e,height:t}=this._texture.orig,n=this._bounds;n.minX=-this._anchor._x*e,n.maxX=n.minX+e,n.minY=-this._anchor._y*t,n.maxY=n.minY+t}get width(){return Math.abs(this.scale.x)*this._texture.orig.width}set width(e){this._setWidth(e,this._texture.orig.width),this._width=e}get height(){return Math.abs(this.scale.y)*this._texture.orig.height}set height(e){this._setHeight(e,this._texture.orig.height),this._height=e}getSize(e={width:0,height:0}){return e.width=Math.abs(this.scale.x)*this._texture.orig.width,e.height=Math.abs(this.scale.y)*this._texture.orig.height,e}setSize(e,t){let n;typeof e==`object`?(t=e.height??e.width,n=e.width):(n=e,t??=e),n!==void 0&&this._setWidth(n,this._texture.orig.width),t!==void 0&&this._setHeight(t,this._texture.orig.height)}collectRenderables(e){let t=this._batchable,n=e.rendererKey??this;t.texture=this._texture,t.transform=this.batchTransform(n,!0);let r=this._batchHistory.get(n);t.onBatchTextures=r.captureTextures,t.color=this.groupColorAlpha,t.roundPixels=this._latchRoundPixels(e),t.blendMode=this.groupBlendMode,this._visualBoundsDirty&&=(dt(this._visualBounds,this._anchor,this._texture),!1),t.bounds=this.isRenderGroup?r.packedBounds:this._visualBounds,e.addBatchable(t)}batchTransform(e,t){let n=this._batchHistory.get(e);if(!n){let t={relative:!this.isRenderGroup,group:null,structureTick:-1,viewTick:-1,validatedViewTick:-1,packedTransform:new S,packedBounds:{minX:0,minY:0,maxX:0,maxY:0},sources:null,sourceGroup:null,sourceStructureTick:-1,captureTextures:e=>{let n=this;for(;n&&!n.isRenderGroup;)n=n.parent;let r=n?._renderedGroupWorldTransform??null,i=n?._renderGroupStructureTick??0;(!t.sources||t.sourceGroup!==r||t.sourceStructureTick!==i)&&(t.sources=e,t.sourceGroup=r,t.sourceStructureTick=i)}};n=t,this._batchHistory.set(e,n)}if(!this.isRenderGroup){if(n.group=null,n.relative)return this.groupTransform;let e=this.parent;for(;e&&!e.isRenderGroup;)e=e.parent;return e?.groupTransform??S.IDENTITY}return(n.group!==this._renderedGroupWorldTransform||n.structureTick!==this._renderGroupStructureTick||t&&n.viewTick!==this._viewUpdateTick)&&(n.packedTransform.copyFrom(this._renderedRelativeTransform??S.IDENTITY),n.group=this._renderedGroupWorldTransform,n.structureTick=this._renderGroupStructureTick,this._visualBoundsDirty&&=(dt(this._visualBounds,this._anchor,this._texture),!1),Object.assign(n.packedBounds,this._visualBounds)),n.viewTick=this._viewUpdateTick,n.relative?this._batchTransform.appendFrom(n.packedTransform,this.groupTransform):this.groupTransform}_prepareRenderGroup(e,t){this.batchTransform(e??this,t)}_validateRenderGroup(e){let t=this._batchHistory.get(e??this);!t||t.validatedViewTick===this._viewUpdateTick||(t.validatedViewTick=this._viewUpdateTick,t.sources&&!t.sources.includes(this._texture.source)&&this._markStructureAsChanged())}unload(){this._batchHistory=new WeakMap,super.unload()}destroy(e=!1){let t=this._texture;if(this._batchHistory=new WeakMap,super.destroy(e),(typeof e==`boolean`?e:e?.texture)&&t){let n=typeof e==`boolean`?e:e?.textureSource;t.destroy(n)}}};function dt(e,t,n){let{width:r,height:i}=n.orig,a=n.trim;a?(e.minX=a.x-t._x*r,e.maxX=e.minX+a.width,e.minY=a.y-t._y*i,e.maxY=e.minY+a.height):(e.minX=-t._x*r,e.maxX=e.minX+r,e.minY=-t._y*i,e.maxY=e.minY+i)}Pe(ut);var R={MAP_READ:1,MAP_WRITE:2,COPY_SRC:4,COPY_DST:8,INDEX:16,VERTEX:32,UNIFORM:64,STORAGE:128,INDIRECT:256,QUERY_RESOLVE:512,STATIC:1024},ft=class extends _{constructor({data:e,size:t,usage:n,label:r,shrinkToFit:i=!0}){super(),this.uid=F(`buffer`),this._resourceType=`buffer`,this.destroyed=!1,this.autoGarbageCollect=!0,this._updateID=1,this._resourceId=F(`resource`),e instanceof Array&&(e=new Float32Array(e)),this._data=e??new Float32Array(Math.ceil((t??0)/4)),t??=this._data.byteLength,this.usage=n,this.label=r,this.shrinkToFit=i,this.descriptor={size:t,usage:n,mappedAtCreation:!!e,label:r},this._updateSize=t}get data(){return this._data}set data(e){this.setDataWithSize(e,e.length,!0)}get static(){return!!(this.usage&R.STATIC)}set static(e){e?this.usage|=R.STATIC:this.usage&=~R.STATIC}setDataWithSize(e,t,n){if(this._updateID++,this._updateSize=t*e.BYTES_PER_ELEMENT,this._data===e){n&&this.emit(`update`,this);return}let r=this._data;if(this._data=e,!r||r.length!==e.length){!this.shrinkToFit&&r&&e.byteLength<r.byteLength?n&&this.emit(`update`,this):(this.descriptor.size=e.byteLength,this._resourceId=F(`resource`),this.emit(`change`,this));return}n&&this.emit(`update`,this)}update(e){this._updateSize=e??this._updateSize,this._updateID++,this.emit(`update`,this)}get _uploadSize(){return Math.min(this._updateSize||this._data.byteLength,this._data.byteLength)}unload(){this.emit(`unload`,this)}destroy(){this.destroyed=!0,this.emit(`destroy`,this),this.emit(`change`,this),this._data=null,this.descriptor=null,this.removeAllListeners()}},pt=class{constructor(e,t=0,n=0){this.buffer=e,this.offset=t,this.size=n,this._resourceType=`bufferResource`,this.uid=F(`buffer`)}},mt=0,ht=500;function gt(...e){mt!==ht&&(mt++,mt===ht?console.warn(`[engine2d] Warning: too many warnings, no more warnings will be reported to the console by engine2d.`):console.warn(`[engine2d] Warning: `,...e))}var _t={uint8x2:2,uint8x4:4,sint8x2:2,sint8x4:4,unorm8x2:2,unorm8x4:4,snorm8x2:2,snorm8x4:4,uint16x2:4,uint16x4:8,sint16x2:4,sint16x4:8,unorm16x2:4,unorm16x4:8,snorm16x2:4,snorm16x4:8,float16x2:4,float16x4:8,float32:4,float32x2:8,float32x3:12,float32x4:16,uint32:4,uint32x2:8,uint32x3:12,uint32x4:16,sint32:4,sint32x2:8,sint32x3:12,sint32x4:16};function vt(e){return e&&_t[e]||_t.float32}var yt={f32:`float32`,"vec2<f32>":`float32x2`,"vec3<f32>":`float32x3`,"vec4<f32>":`float32x4`,vec2f:`float32x2`,vec3f:`float32x3`,vec4f:`float32x4`,i32:`sint32`,"vec2<i32>":`sint32x2`,"vec3<i32>":`sint32x3`,"vec4<i32>":`sint32x4`,vec2i:`sint32x2`,vec3i:`sint32x3`,vec4i:`sint32x4`,u32:`uint32`,"vec2<u32>":`uint32x2`,"vec3<u32>":`uint32x3`,"vec4<u32>":`uint32x4`,vec2u:`uint32x2`,vec3u:`uint32x3`,vec4u:`uint32x4`,bool:`uint32`,"vec2<bool>":`uint32x2`,"vec3<bool>":`uint32x3`,"vec4<bool>":`uint32x4`};function bt(e,t){let n=e.attributes;for(let e in n){let r=n[e],i=t.find(t=>t.name===e);i?r.format??=yt[i.type]??`float32`:r.format===void 0&&gt(`Attribute ${e} is not present in the shader, but is present in the geometry. Unable to infer attribute details.`)}let r=new Map;for(let e in n){let t=n[e];r.set(t.buffer,(r.get(t.buffer)??0)+vt(t.format))}for(let e in n){let t=n[e];t.stride??=r.get(t.buffer)}}function xt(e){let t=_t[e];if(!t)throw Error(`[engine2d] 不认识的顶点格式 ${e}`);return t}function St(e,t){return e instanceof ft?e:new ft({data:e instanceof Array?t?new Uint32Array(e):new Float32Array(e):e,usage:(t?R.INDEX:R.VERTEX)|R.COPY_DST,label:t?`index`:`attribute`})}var Ct=class extends _{constructor(e={}){super(),this.uid=F(`geometry`),this._layoutKey=F(`geometryLayout`),this.attributes={},this.buffers=[],this.destroyed=!1,this._attributesVersion=0,this._boundsDirty=!0,this._bounds=new L,this.label=e.label,this.topology=e.topology??`triangle-list`,this.instanceCount=e.instanceCount??1;for(let t in e.attributes??{})this.addAttribute(t,e.attributes[t]);e.indexBuffer&&this.addIndex(e.indexBuffer)}addAttribute(e,t){let n=t instanceof ft||ArrayBuffer.isView(t)||Array.isArray(t)?{buffer:t}:t,r=St(n.buffer,!1);this.attributes[e]={buffer:r,format:n.format,stride:n.stride,offset:n.offset??0,instance:n.instance??!1,start:n.start},this._attributesVersion++,this.buffers.includes(r)||(this.buffers.push(r),r.on(`update`,this.onBufferUpdate,this),r.on(`change`,this.onBufferUpdate,this))}addIndex(e){let t=St(e,!0);t.usage|=R.INDEX,this.indexBuffer=t,this.buffers.includes(t)||this.buffers.push(t)}getAttribute(e){return this.attributes[e]}getIndex(){return this.indexBuffer}getBuffer(e){return this.getAttribute(e).buffer}getSize(){for(let e in this.attributes){let t=this.attributes[e];if(t.instance)continue;let n=t.stride||vt(t.format);return t.buffer.data.byteLength/n}return 0}get bounds(){if(!this._boundsDirty)return this._bounds;this._boundsDirty=!1;let e=this._bounds.clear(),t=this.attributes.aPosition;if(!t)return e;let n=t.buffer.data,r=(t.stride||8)/4,i=(t.offset??0)/4,a=1/0,o=1/0,s=-1/0,c=-1/0;for(let e=i;e+1<n.length;e+=r){let t=n[e],r=n[e+1];t<a&&(a=t),r<o&&(o=r),t>s&&(s=t),r>c&&(c=r)}return e.minX=a,e.minY=o,e.maxX=s,e.maxY=c,e}onBufferUpdate(){this._boundsDirty=!0,this.emit(`update`,this)}destroy(e=!1){if(this.destroyed=!0,this.emit(`destroy`,this),this.removeAllListeners(),e)for(let e of this.buffers)e.destroy();this.indexBuffer&&!this.indexBuffer.destroyed&&this.indexBuffer.destroy(),this.attributes={},this.buffers=[],this.indexBuffer=void 0}},wt={i32:{align:4,size:4},u32:{align:4,size:4},f32:{align:4,size:4},f16:{align:2,size:2},"vec2<i32>":{align:8,size:8},"vec2<u32>":{align:8,size:8},"vec2<f32>":{align:8,size:8},"vec2<f16>":{align:4,size:4},"vec3<i32>":{align:16,size:12},"vec3<u32>":{align:16,size:12},"vec3<f32>":{align:16,size:12},"vec3<f16>":{align:8,size:6},"vec4<i32>":{align:16,size:16},"vec4<u32>":{align:16,size:16},"vec4<f32>":{align:16,size:16},"vec4<f16>":{align:8,size:8},"mat2x2<f32>":{align:8,size:16},"mat2x2<f16>":{align:4,size:8},"mat3x2<f32>":{align:8,size:24},"mat3x2<f16>":{align:4,size:12},"mat4x2<f32>":{align:8,size:32},"mat4x2<f16>":{align:4,size:16},"mat2x3<f32>":{align:16,size:32},"mat2x3<f16>":{align:8,size:16},"mat3x3<f32>":{align:16,size:48},"mat3x3<f16>":{align:8,size:24},"mat4x3<f32>":{align:16,size:64},"mat4x3<f16>":{align:8,size:32},"mat2x4<f32>":{align:16,size:32},"mat2x4<f16>":{align:8,size:16},"mat3x4<f32>":{align:16,size:48},"mat3x4<f16>":{align:8,size:24},"mat4x4<f32>":{align:16,size:64},"mat4x4<f16>":{align:8,size:32}};function Tt(e){let t=0,n=[];for(let r of e){let e=wt[r.type];if(!e)throw Error(`[engine2d] uniform 缓冲:不支持的类型 ${r.type}(${r.name})`);let i=e.size;r.size>1&&(i=Math.max(i,e.align)*r.size),t=Math.ceil(t/e.align)*e.align,n.push({name:r.name,type:r.type,size:r.size,offset:t,byteSize:i}),t+=i}return{elements:n,size:Math.ceil(t/16)*16}}function Et(e){return e===`i32`||e.endsWith(`<i32>`)}function Dt(e){return e===`u32`||e.endsWith(`<u32>`)}var Ot=new Map;function kt(e){let t=Ot.get(e);if(!t){let n=/^mat(\d)x(\d)/.exec(e);t={view:Et(e)?1:Dt(e)?2:0,matCol:n?Number(n[1]):0,matTotal:n?Number(n[1])*Number(n[2]):0,comps:e.startsWith(`vec`)?Number(e[3]):1},Ot.set(e,t)}return t}function At(e,t,n,r,i,a){for(let o of e.elements){let e=t[o.name],s=a+o.offset/4,c=kt(o.type).view,l=c===1?r:c===2?i:n;if(o.size>1){let{size:t,align:n}=wt[o.type],r=t/4,i=Math.max(t,n)/4,a=e;if(o.type.startsWith(`mat`)){for(let e=0;e<o.size;e++)Nt(o.type,Mt(a,e*jt(o.type),jt(o.type)),l,s+e*i);continue}for(let e=0,t=0;e<o.size;e++)for(let n=0;n<r;n++)l[s+e*i+n]=a[t++]??0;continue}Nt(o.type,e,l,s)}}function jt(e){let t=/^mat(\d)x(\d)/.exec(e);return Number(t[1])*Number(t[2])}function Mt(e,t,n){let r=[];for(let i=0;i<n;i++)r.push(e[t+i]);return r}function Nt(e,t,n,r){if(typeof t==`number`){n[r]=t;return}if(t==null)return;let i=t;if(e===`mat3x3<f32>`&&i.a!==void 0&&typeof i.toArray==`function`){let e=i.toArray(!0);n[r]=e[0],n[r+1]=e[1],n[r+2]=e[2],n[r+4]=e[3],n[r+5]=e[4],n[r+6]=e[5],n[r+8]=e[6],n[r+9]=e[7],n[r+10]=e[8];return}if(e===`vec4<f32>`&&i.width!==void 0){n[r]=i.x,n[r+1]=i.y,n[r+2]=i.width,n[r+3]=i.height;return}if(e===`vec2<f32>`&&i.x!==void 0){n[r]=i.x,n[r+1]=i.y;return}if((e===`vec4<f32>`||e===`vec3<f32>`)&&i.red!==void 0){n[r]=i.red,n[r+1]=i.green,n[r+2]=i.blue,e===`vec4<f32>`&&(n[r+3]=i.alpha);return}let a=t;switch(e){case`mat2x2<f32>`:n[r]=a[0],n[r+1]=a[1],n[r+2]=a[2],n[r+3]=a[3];return;case`mat3x3<f32>`:n[r]=a[0],n[r+1]=a[1],n[r+2]=a[2],n[r+4]=a[3],n[r+5]=a[4],n[r+6]=a[5],n[r+8]=a[6],n[r+9]=a[7],n[r+10]=a[8];return;case`mat4x4<f32>`:for(let e=0;e<16;e++)n[r+e]=a[e];return;default:{let t=kt(e);if(t.matCol){let e=t.matCol,i=t.matTotal;for(let t=0;t<i;t++)n[r+(t/e|0)*4+t%e]=a[t];return}let i=t.comps;for(let e=0;e<i;e++)n[r+e]=a[e]}}}var Pt=class{constructor(e,t={}){this.uid=F(`uniform`),this._resourceType=`uniformGroup`,this.isUniformGroup=!0,this._dirtyId=1,this.destroyed=!1,this._layout=null,this.uniformStructures=e;let n={};for(let t in e){let r=e[t];if(r.name=t,r.size=r.size??1,!wt[r.type])throw Error(`[engine2d] Uniform「${t}」的类型 ${r.type} 不支持`);r.value??=Ft(r.type,r.size),n[t]=r.value}this.uniforms=n,this.ubo=!!t.ubo,this.isStatic=!!t.isStatic}get layout(){return this._layout??=Tt(Object.keys(this.uniformStructures).map(e=>({name:e,type:this.uniformStructures[e].type,size:this.uniformStructures[e].size??1})))}update(){this._dirtyId++}destroy(){this.destroyed=!0}};function Ft(e,t){switch(e){case`f32`:case`i32`:case`u32`:return t>1?new Float32Array(t):0;case`vec2<f32>`:return new Float32Array(2*t);case`vec3<f32>`:return new Float32Array(3*t);case`vec4<f32>`:return new Float32Array(4*t);case`vec2<i32>`:return new Int32Array(2*t);case`vec3<i32>`:return new Int32Array(3*t);case`vec4<i32>`:return new Int32Array(4*t);case`mat2x2<f32>`:return new Float32Array([1,0,0,1]);case`mat3x3<f32>`:return t>1?new Float32Array(9*t):new S;case`mat4x4<f32>`:return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);default:return null}}var It=new Map,Lt=class e{constructor(e){this.uid=F(`program`),this._attributes=null,this._bindings=null,this._structs=null,this.vertex=e.vertex,this.fragment=e.fragment,this.name=e.name;let t=e.vertex.source,n=e.fragment?.source??t;this.vertexEntry=e.vertex.entryPoint??Rt(t,`vertex`)??`main`,this.fragmentEntry=e.fragment?.entryPoint??Rt(n,`fragment`)??`main`,t===n?this.source=t:this.source=Ht(t,n,this.vertexEntry,this.fragmentEntry)}get attributes(){return this._attributes??=zt(this.vertex.source,this.vertexEntry)}get bindings(){return this._bindings??=Vt(this.source)}get structsAndGroups(){let e=this.bindings;return{groups:e,structs:(this._structs??=Bt(this.source)).filter(t=>e.some(e=>e.type===t.name))}}get autoAssignGlobalUniforms(){return this.bindings.some(e=>e.name===`globalUniforms`)}get autoAssignLocalUniforms(){return this.bindings.some(e=>e.name===`localUniforms`)}destroy(){}static from(t){let n=`${t.vertex.source}:${t.fragment?.source}:${t.vertex.entryPoint}:${t.fragment?.entryPoint}`,r=It.get(n);return r||(r=new e(t),It.set(n,r)),r}};function Rt(e,t){return RegExp(`@${t}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(e)?.[1]}function zt(e,t){let n=RegExp(`fn\\s+${t}\\s*\\(`).exec(e);if(!n)return[];let r=1,i=n.index+n[0].length,a=i;for(;i<e.length&&r>0;i++)e[i]===`(`?r++:e[i]===`)`&&r--;let o=e.slice(a,i-1),s=[],c=/@location\s*\(\s*(\d+)\s*\)\s*(?:@interpolate\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+)/g,l;for(;l=c.exec(o);)s.push({location:Number(l[1]),name:l[2],type:l[3]});return s}function Bt(e){let t=e.replace(/\/\*[\s\S]*?\*\//g,``).replace(/\/\/[^\n]*/g,``),n=[],r=/struct\s+(\w+)\s*{([^}]+)}/g,i;for(;i=r.exec(t);){let e={};for(let t of i[2].matchAll(/(\w+)\s*:\s*([\w<>]+)/g))e[t[1]]=t[2];n.push({name:i[1],members:e})}return n}function Vt(e){let t=e.replace(/\/\*[\s\S]*?\*\//g,``).replace(/\/\/[^\n]*/g,``),n=[],r=/@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var\s*(<[^>]*>)?\s*([A-Za-z_]\w*)\s*:\s*([^;]+);/g,i;for(;i=r.exec(t);)n.push({group:Number(i[1]),binding:Number(i[2]),name:i[4],isUniform:!!i[3]&&/uniform/.test(i[3]),type:i[5].trim()});return n}function Ht(e,t,n,r){let i=new Set,a=[];for(let n of[e,t])for(let e of Ut(n)){let t=Wt(e);t&&i.has(t)||(t&&i.add(t),a.push(e))}return a.join(`
`)}function Ut(e){let t=e.replace(/\/\*[\s\S]*?\*\//g,``).replace(/\/\/[^\n]*/g,``),n=[],r=0,i=0;for(let e=0;e<t.length;e++){let a=t[e];if(a===`{`)r++;else if(a===`}`){if(r--,r===0){let r=e+1;for(;r<t.length&&/[\s;]/.test(t[r]);){if(t[r]===`;`){r++;break}r++}n.push(t.slice(i,r).trim()),i=r,e=r-1}}else a===`;`&&r===0&&(n.push(t.slice(i,e+1).trim()),i=e+1)}let a=t.slice(i).trim();return a&&n.push(a),n.filter(Boolean)}function Wt(e){let t=/^struct\s+([A-Za-z_]\w*)/.exec(e);return t?`struct:${t[1]}`:(t=/var\s*(?:<[^>]*>)?\s*([A-Za-z_]\w*)\s*:/.exec(e),t&&/^(@group|var|@binding)/.test(e)?`var:${t[1]}`:(t=/^(?:@\w+(?:\([^)]*\))?\s+)*fn\s+([A-Za-z_]\w*)/.exec(e),t?`fn:${t[1]}`:(t=/^(?:const|override|alias)\s+([A-Za-z_]\w*)/.exec(e),t?`const:${t[1]}`:null)))}var Gt=class e{constructor(e){this.vertex=e.vertex,this.fragment=e.fragment,this.name=e.name}destroy(){}static from(t){return new e(t)}},Kt={WEBGL:1,WEBGPU:2,CANVAS:4,BOTH:3},qt=class e extends _{constructor(e){super(),this.uid=F(`shader`),this._destroyed=!1,this.gpuProgram=e.gpuProgram??null,this.glProgram=e.glProgram??null,this.compatibleRenderers=e.compatibleRenderers??(this.gpuProgram?Kt.WEBGPU:0)|(this.glProgram?Kt.WEBGL:0);let t={};for(let[n,r]of Object.entries(e.resources??{}))t[n]=Jt(r);this.resources=t}addResource(e,t,n){}destroy(e=!1){this._destroyed||(this._destroyed=!0,this.emit(`destroy`,this),e&&(this.gpuProgram?.destroy(),this.glProgram?.destroy()),this.gpuProgram=null,this.glProgram=null,this.removeAllListeners(),this.resources={})}static from(t){let{gpu:n,gl:r,...i}=t;return new e({gpuProgram:n?Lt.from(n):void 0,glProgram:r?Gt.from(r):void 0,...i})}};function Jt(e){return e&&typeof e==`object`&&!(`source`in e)&&!(`_resourceType`in e)?new Pt(e):e}var Yt=class extends Ct{constructor(e={}){let t=e.positions||new Float32Array([0,0,1,0,1,1,0,1]),n=e.uvs;n||=e.positions?new Float32Array(t.length):new Float32Array([0,0,1,0,1,1,0,1]);let r=e.indices||new Uint32Array([0,1,2,0,2,3]),i=e.shrinkBuffersToFit??!1;super({attributes:{aPosition:{buffer:new ft({data:t,label:`attribute-mesh-positions`,shrinkToFit:i,usage:R.VERTEX|R.COPY_DST}),format:`float32x2`,stride:8,offset:0},aUV:{buffer:new ft({data:n,label:`attribute-mesh-uvs`,shrinkToFit:i,usage:R.VERTEX|R.COPY_DST}),format:`float32x2`,stride:8,offset:0}},indexBuffer:new ft({data:r,label:`index-mesh-buffer`,shrinkToFit:i,usage:R.INDEX|R.COPY_DST}),topology:e.topology??`triangle-list`}),this.batchMode=`auto`}get positions(){return this.attributes.aPosition.buffer.data}set positions(e){this.attributes.aPosition.buffer.data=e}get uvs(){return this.attributes.aUV.buffer.data}set uvs(e){this.attributes.aUV.buffer.data=e}get indices(){return this.indexBuffer.data}set indices(e){this.indexBuffer.data=e}},Xt=class e extends Yt{static{this.defaultOptions={width:100,height:100,verticesX:10,verticesY:10}}constructor(e={}){super({}),this.build(e)}build(t){let n={...e.defaultOptions,...t};this.verticesX=this.verticesX??n.verticesX,this.verticesY=this.verticesY??n.verticesY,this.width=this.width??n.width,this.height=this.height??n.height;let r=this.verticesX*this.verticesY,i=[],a=[],o=[],s=this.verticesX-1,c=this.verticesY-1,l=this.width/s,u=this.height/c;for(let e=0;e<r;e++){let t=e%this.verticesX,n=e/this.verticesX|0;i.push(t*l,n*u),a.push(t/s,n/c)}let d=s*c;for(let e=0;e<d;e++){let t=e%s,n=e/s|0,r=n*this.verticesX+t,i=n*this.verticesX+t+1,a=(n+1)*this.verticesX+t,c=(n+1)*this.verticesX+t+1;o.push(r,i,a,i,c,a)}this.buffers[0].data=new Float32Array(i),this.buffers[1].data=new Float32Array(a),this.indexBuffer.data=new Uint32Array(o),this.buffers[0].update(),this.buffers[1].update(),this.indexBuffer.update()}},Zt=class extends lt{constructor(e){let{geometry:t,shader:n,texture:r,roundPixels:i,state:a,...o}=e;super({label:`Mesh`,...o}),this.renderPipeId=`mesh`,this._shader=null,this._transformedUvs=null,this._uvKey=``,this.shader=n??null,this.texture=r??n?.texture??I.WHITE,this.state=a??{},this._geometry=t,this._geometry.on(`update`,this.onViewUpdate,this),this.roundPixels=i??!1,this._batchable={texture:this._texture,transform:this.groupTransform,color:4294967295,roundPixels:0,blendMode:`normal`,topology:`triangle-list`,packAsQuad:!1,attributeOffset:0,attributeSize:0,indexOffset:0,indexSize:0}}get shader(){return this._shader}set shader(e){this._shader!==e&&(this._shader=e,this.onViewUpdate())}get geometry(){return this._geometry}set geometry(e){this._geometry!==e&&(this._geometry?.off(`update`,this.onViewUpdate,this),e.on(`update`,this.onViewUpdate,this),this._geometry=e,this.onViewUpdate())}get texture(){return this._texture}set texture(e){e||=I.EMPTY;let t=this._texture;t!==e&&(t&&t.dynamic&&t.off(`update`,this.onViewUpdate,this),e.dynamic&&e.on(`update`,this.onViewUpdate,this),this._shader&&(this._shader.texture=e),this._texture=e,this.onViewUpdate())}get batched(){if(this._shader)return!1;let e=this._geometry;return e instanceof Yt?e.batchMode===`auto`?e.positions.length/2<=100:e.batchMode===`batch`:!1}get bounds(){return this._geometry.bounds}updateBounds(){}containsPoint(e){let{x:t,y:n}=e;if(!this.bounds.containsPoint(t,n))return!1;let r=this.geometry.getBuffer(`aPosition`).data,i=this.geometry.topology===`triangle-strip`?3:1,a=this.geometry.indexBuffer;if(a){let e=a.data;for(let a=0;a+2<e.length;a+=i){let i=e[a]*2,o=e[a+1]*2,s=e[a+2]*2;if(Qt(t,n,r[i],r[i+1],r[o],r[o+1],r[s],r[s+1]))return!0}}else{let e=r.length/2;for(let a=0;a+2<e;a+=i){let e=a*2,i=(a+1)*2,o=(a+2)*2;if(Qt(t,n,r[e],r[e+1],r[i],r[i+1],r[o],r[o+1]))return!0}}return!1}collectRenderables(e){if(!this.batched){e.addCustom(this);return}let t=this._geometry,n=this._batchable;n.texture=this._texture,n.transform=this.groupTransform,n.color=this.groupColorAlpha,n.roundPixels=this._latchRoundPixels(e),n.blendMode=this.groupBlendMode,n.topology=t.topology,n.positions=t.positions,n.uvs=this.batchUvs(t),n.indices=t.indices,n.attributeSize=t.positions.length/2,n.indexSize=t.indices.length,e.addBatchable(n)}batchUvs(e){let t=e.getBuffer(`aUV`),n=t.data,r=this._texture.textureMatrix;if(r.isSimple)return n;let i=`${r._updateID}:${t._updateID}:${this._texture.uid}`;return(!this._transformedUvs||this._transformedUvs.length<n.length)&&(this._transformedUvs=new Float32Array(n.length)),this._uvKey!==i&&(this._uvKey=i,r.multiplyUvs(n,this._transformedUvs)),this._transformedUvs}destroy(e=!1){let t=this._texture;if(super.destroy(e),(typeof e==`boolean`?e:e?.texture)&&t){let n=typeof e==`boolean`?e:e?.textureSource;t.destroy(n)}this._geometry?.off(`update`,this.onViewUpdate,this)}};function Qt(e,t,n,r,i,a,o,s){let c=o-n,l=s-r,u=i-n,d=a-r,f=e-n,p=t-r,m=c*c+l*l,h=c*u+l*d,g=c*f+l*p,_=u*u+d*d,v=u*f+d*p,y=1/(m*_-h*h),b=(_*g-h*v)*y,x=(m*v-h*g)*y;return b>=0&&x>=0&&b+x<1}var $t=class e extends qt{static{this.defaultOptions={blendMode:`normal`,resolution:1,padding:0,antialias:`off`,blendRequired:!1,clipToViewport:!0}}constructor(t){let n={...e.defaultOptions,...t};super(n),this.enabled=!0,this.blendMode=n.blendMode,this.padding=n.padding,this.antialias=typeof n.antialias==`boolean`?n.antialias?`on`:`off`:n.antialias,this.resolution=n.resolution,this.blendRequired=n.blendRequired,this.clipToViewport=n.clipToViewport}apply(e,t,n,r){e.applyFilter(this,t,n,r)}static from(t){let{gpu:n,gl:r,...i}=t;return new e({gpuProgram:n?Lt.from(n):void 0,glProgram:r?Gt.from(r):void 0,...i})}},en=`struct GlobalFilterUniforms {
  uInputSize:vec4<f32>,
  uInputPixel:vec4<f32>,
  uInputClamp:vec4<f32>,
  uOutputFrame:vec4<f32>,
  uGlobalFrame:vec4<f32>,
  uOutputTexture:vec4<f32>,
};

struct AlphaUniforms {
  uAlpha:f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler : sampler;

@group(1) @binding(0) var<uniform> alphaUniforms : AlphaUniforms;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv : vec2<f32>
  };

fn filterVertexPosition(aPosition:vec2<f32>) -> vec4<f32>
{
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;

    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

fn globalTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
  return  (aPosition.xy / gfu.uGlobalFrame.zw) + (gfu.uGlobalFrame.xy / gfu.uGlobalFrame.zw);  
}

fn getSize() -> vec2<f32>
{
  return gfu.uGlobalFrame.zw;
}
  
@vertex
fn mainVertex(
  @location(0) aPosition : vec2<f32>, 
) -> VSOutput {
  return VSOutput(
   filterVertexPosition(aPosition),
   filterTextureCoord(aPosition)
  );
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @builtin(position) position: vec4<f32>
) -> @location(0) vec4<f32> {
 
    var sample = textureSample(uTexture, uSampler, uv);
    
    return sample * alphaUniforms.uAlpha;
}`;(class e extends $t{static{this.defaultOptions={alpha:1}}constructor(t){t={...e.defaultOptions,...t};let n=Lt.from({vertex:{source:en,entryPoint:`mainVertex`},fragment:{source:en,entryPoint:`mainFragment`}}),{alpha:r,...i}=t,a=new Pt({uAlpha:{value:r,type:`f32`}});super({...i,gpuProgram:n,resources:{alphaUniforms:a}})}get alpha(){return this.resources.alphaUniforms.uniforms.uAlpha}set alpha(e){this.resources.alphaUniforms.uniforms.uAlpha=e}});var tn={5:[.153388,.221461,.250301],7:[.071303,.131514,.189879,.214607],9:[.028532,.067234,.124009,.179044,.20236],11:[.0093,.028002,.065984,.121703,.175713,.198596],13:[.002406,.009255,.027867,.065666,.121117,.174868,.197641],15:[489e-6,.002403,.009246,.02784,.065602,.120999,.174697,.197448]},nn=`

struct GlobalFilterUniforms {
  uInputSize:vec4<f32>,
  uInputPixel:vec4<f32>,
  uInputClamp:vec4<f32>,
  uOutputFrame:vec4<f32>,
  uGlobalFrame:vec4<f32>,
  uOutputTexture:vec4<f32>,
};

struct BlurUniforms {
  uStrength:f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler : sampler;

@group(1) @binding(0) var<uniform> blurUniforms : BlurUniforms;


struct VSOutput {
    @builtin(position) position: vec4<f32>,
    %blur-struct%
  };

fn filterVertexPosition(aPosition:vec2<f32>) -> vec4<f32>
{
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;

    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

fn globalTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
  return  (aPosition.xy / gfu.uGlobalFrame.zw) + (gfu.uGlobalFrame.xy / gfu.uGlobalFrame.zw);
}

fn getSize() -> vec2<f32>
{
  return gfu.uGlobalFrame.zw;
}


@vertex
fn mainVertex(
  @location(0) aPosition : vec2<f32>,
) -> VSOutput {

  let filteredCord = filterTextureCoord(aPosition);

  let pixelStrength = gfu.uInputSize.%dimension% * blurUniforms.uStrength;

  return VSOutput(
   filterVertexPosition(aPosition),
    %blur-vertex-out%
  );
}

@fragment
fn mainFragment(
  @builtin(position) position: vec4<f32>,
  %blur-fragment-in%
) -> @location(0) vec4<f32> {

    var   finalColor = vec4(0.0);

    %blur-sampling%

    return finalColor;
}
`;function rn(e,t){let n=tn[t],r=n.length,i=[],a=[],o=[];for(let s=0;s<t;s++){i[s]=`@location(${s}) offset${s}: vec2<f32>,`,e?a[s]=`filteredCord + vec2(${s-r+1} * pixelStrength, 0.0),`:a[s]=`filteredCord + vec2(0.0, ${s-r+1} * pixelStrength),`;let c=n[s<r?s:t-s-1].toString();o[s]=`finalColor += textureSample(uTexture, uSampler, offset${s}) * ${c};`}let s=i.join(`
`),c=a.join(`
`),l=o.join(`
`),u=nn.replace(`%blur-struct%`,s).replace(`%blur-vertex-out%`,c).replace(`%blur-fragment-in%`,s).replace(`%blur-sampling%`,l).replace(`%dimension%`,e?`z`:`w`);return Lt.from({vertex:{source:u,entryPoint:`mainVertex`},fragment:{source:u,entryPoint:`mainFragment`}})}var an=class e extends $t{static{this.defaultOptions={strength:8,quality:4,kernelSize:5,legacy:!1}}constructor(t){t={...e.defaultOptions,...t};let n=rn(t.horizontal,t.kernelSize);super({gpuProgram:n,resources:{blurUniforms:{uStrength:{value:0,type:`f32`}}},...t}),this.horizontal=t.horizontal,this.legacy=t.legacy??!1,this._quality=0,this.quality=t.quality,this.blur=t.strength,this._blurUniforms=this.resources.blurUniforms,this._uniforms=this._blurUniforms.uniforms}apply(e,t,n,r){this.legacy?this._applyLegacy(e,t,n,r):this._applyOptimized(e,t,n,r)}_applyLegacy(e,t,n,r){if(this._uniforms.uStrength=this.strength/this.passes,this.passes===1)e.applyFilter(this,t,n,r);else{let i=Se.getSameSizeTexture(t),a=t,o=i,s=this.blendMode;this.blendMode=`none`;for(let t=0;t<this.passes-1;t++){e.applyFilter(this,a,o,t===0);let n=o;o=a,a=n}this.blendMode=s,e.applyFilter(this,a,n,r),Se.returnTexture(i)}}_applyOptimized(e,t,n,r){if(this._uniforms.uStrength=this._calculateInitialStrength(),this.passes===1)e.applyFilter(this,t,n,r);else{let i=Se.getSameSizeTexture(t),a=t,o=i,s=this.blendMode;this.blendMode=`none`;for(let t=0;t<this.passes-1;t++){e.applyFilter(this,a,o,!1);let t=o;o=a,a=t,this._uniforms.uStrength*=.5}this.blendMode=s,e.applyFilter(this,a,n,r),Se.returnTexture(i)}}_calculateInitialStrength(){let e=1,t=.5;for(let n=1;n<this.passes;n++)e+=t*t,t*=.5;return this.strength/Math.sqrt(e)}get blur(){return this.strength}set blur(e){this.padding=1+Math.abs(e)*2,this.strength=e}get quality(){return this._quality}set quality(e){this._quality=e,this.passes=e}},on=class extends $t{static{this.defaultOptions={strength:8,quality:4,kernelSize:5,legacy:!1}}constructor(...e){let t=e[0]??{};typeof t==`number`&&(t={strength:t},e[1]!==void 0&&(t.quality=e[1]),e[2]!==void 0&&(t.resolution=e[2]||`inherit`),e[3]!==void 0&&(t.kernelSize=e[3])),t={...an.defaultOptions,...t};let{strength:n,strengthX:r,strengthY:i,quality:a,...o}=t;super({...o,compatibleRenderers:Kt.BOTH,resources:{}}),this._repeatEdgePixels=!1,this.blurXFilter=new an({horizontal:!0,...t}),this.blurYFilter=new an({horizontal:!1,...t}),this.quality=a,this.strengthX=r??n,this.strengthY=i??n,this.repeatEdgePixels=!1}apply(e,t,n,r){let i=Math.abs(this.blurXFilter.strength),a=Math.abs(this.blurYFilter.strength);if(i&&a){let i=Se.getSameSizeTexture(t);this.blurXFilter.blendMode=`normal`,this.blurXFilter.apply(e,t,i,!0),this.blurYFilter.blendMode=this.blendMode,this.blurYFilter.apply(e,i,n,r),Se.returnTexture(i)}else a?(this.blurYFilter.blendMode=this.blendMode,this.blurYFilter.apply(e,t,n,r)):(this.blurXFilter.blendMode=this.blendMode,this.blurXFilter.apply(e,t,n,r))}updatePadding(){this._repeatEdgePixels?this.padding=0:this.padding=Math.max(Math.abs(this.blurXFilter.blur),Math.abs(this.blurYFilter.blur))*2}get strength(){if(this.strengthX!==this.strengthY)throw Error(`BlurFilter's strengthX and strengthY are different`);return this.strengthX}set strength(e){this.blurXFilter.blur=this.blurYFilter.blur=e,this.updatePadding()}get quality(){return this.blurXFilter.quality}set quality(e){this.blurXFilter.quality=this.blurYFilter.quality=e}get strengthX(){return this.blurXFilter.blur}set strengthX(e){this.blurXFilter.blur=e,this.updatePadding()}get strengthY(){return this.blurYFilter.blur}set strengthY(e){this.blurYFilter.blur=e,this.updatePadding()}get blur(){return this.strength}set blur(e){this.strength=e}get blurX(){return this.strengthX}set blurX(e){this.strengthX=e}get blurY(){return this.strengthY}set blurY(e){this.strengthY=e}get repeatEdgePixels(){return this._repeatEdgePixels}set repeatEdgePixels(e){this._repeatEdgePixels=e,this.updatePadding()}},sn=class e extends Xt{static{this.defaultOptions={width:100,height:100,leftWidth:10,topHeight:10,rightWidth:10,bottomHeight:10,originalWidth:100,originalHeight:100,verticesX:4,verticesY:4}}constructor(t={}){t={...e.defaultOptions,...t},super({width:t.width,height:t.height,verticesX:4,verticesY:4}),this._trimX=0,this._trimY=0,this._trimWidth=t.originalWidth??e.defaultOptions.originalWidth,this._trimHeight=t.originalHeight??e.defaultOptions.originalHeight,this.update(t)}update(e){this.width=e.width??this.width,this.height=e.height??this.height,this._originalWidth=e.originalWidth??this._originalWidth,this._originalHeight=e.originalHeight??this._originalHeight,this._leftWidth=e.leftWidth??this._leftWidth,this._rightWidth=e.rightWidth??this._rightWidth,this._topHeight=e.topHeight??this._topHeight,this._bottomHeight=e.bottomHeight??this._bottomHeight,this._anchorX=e.anchor?.x,this._anchorY=e.anchor?.y,e.trim===void 0?(this._trimWidth=this._originalWidth,this._trimHeight=this._originalHeight):(this._trimX=e.trim?.x??0,this._trimY=e.trim?.y??0,this._trimWidth=e.trim?.width??this._originalWidth,this._trimHeight=e.trim?.height??this._originalHeight),this.updateUvs(),this.updatePositions()}updatePositions(){let e=this.positions,{width:t,height:n,_leftWidth:r,_rightWidth:i,_topHeight:a,_bottomHeight:o,_anchorX:s,_anchorY:c}=this,l=r+i,u=t>l?1:t/l,d=a+o,f=n>d?1:n/d,p=Math.min(u,f),m=s*t,h=c*n;e[0]=e[8]=e[16]=e[24]=-m,e[2]=e[10]=e[18]=e[26]=r*p-m,e[4]=e[12]=e[20]=e[28]=t-i*p-m,e[6]=e[14]=e[22]=e[30]=t-m,e[1]=e[3]=e[5]=e[7]=-h,e[9]=e[11]=e[13]=e[15]=a*p-h,e[17]=e[19]=e[21]=e[23]=n-o*p-h,e[25]=e[27]=e[29]=e[31]=n-h,this.getBuffer(`aPosition`).update()}updateUvs(){let e=this.uvs,t=this._originalWidth,n=this._originalHeight,r=this._trimX/t,i=this._trimY/n,a=(this._trimX+this._trimWidth)/t,o=(this._trimY+this._trimHeight)/n;e[0]=e[8]=e[16]=e[24]=r,e[1]=e[3]=e[5]=e[7]=i,e[6]=e[14]=e[22]=e[30]=a,e[25]=e[27]=e[29]=e[31]=o;let s=1/t,c=1/n;e[2]=e[10]=e[18]=e[26]=r+s*this._leftWidth,e[9]=e[11]=e[13]=e[15]=i+c*this._topHeight,e[4]=e[12]=e[20]=e[28]=a-s*this._rightWidth,e[17]=e[19]=e[21]=e[23]=o-c*this._bottomHeight,this.getBuffer(`aUV`).update()}};(class e extends lt{static{this.defaultOptions={texture:I.EMPTY}}constructor(t){t instanceof I&&(t={texture:t});let{width:n,height:r,anchor:i,leftWidth:a,rightWidth:o,topHeight:s,bottomHeight:c,texture:l,roundPixels:u,...d}=t;super({label:`NineSliceSprite`,...d}),this.renderPipeId=`nineSliceSprite`,this.batched=!0,this._geometry=null,this._geometryDirty=!0,this._transformedUvs=null,this._uvKey=``,this._batchable={texture:I.EMPTY,transform:this.groupTransform,color:4294967295,roundPixels:0,blendMode:`normal`,topology:`triangle-list`,packAsQuad:!1,attributeOffset:0,attributeSize:0,indexOffset:0,indexSize:0},this._leftWidth=a??l?.defaultBorders?.left??sn.defaultOptions.leftWidth,this._topHeight=s??l?.defaultBorders?.top??sn.defaultOptions.topHeight,this._rightWidth=o??l?.defaultBorders?.right??sn.defaultOptions.rightWidth,this._bottomHeight=c??l?.defaultBorders?.bottom??sn.defaultOptions.bottomHeight,this._width=n??l.width??sn.defaultOptions.width,this._height=r??l.height??sn.defaultOptions.height,this.allowChildren=!1,this.texture=l??e.defaultOptions.texture,this.roundPixels=u??!1,this._anchor=new b({_onUpdate:()=>{this.onViewUpdate()}}),i?this.anchor=i:this.texture.defaultAnchor&&(this.anchor=this.texture.defaultAnchor)}get anchor(){return this._anchor}set anchor(e){typeof e==`number`?this._anchor.set(e):this._anchor.copyFrom(e)}get width(){return this._width}set width(e){this._width=e,this.onViewUpdate()}get height(){return this._height}set height(e){this._height=e,this.onViewUpdate()}setSize(e,t){typeof e==`object`&&(t=e.height??e.width,e=e.width),this._width=e,this._height=t??e,this.onViewUpdate()}getSize(e){return e||={},e.width=this._width,e.height=this._height,e}get leftWidth(){return this._leftWidth}set leftWidth(e){this._leftWidth=e,this.onViewUpdate()}get topHeight(){return this._topHeight}set topHeight(e){this._topHeight=e,this.onViewUpdate()}get rightWidth(){return this._rightWidth}set rightWidth(e){this._rightWidth=e,this.onViewUpdate()}get bottomHeight(){return this._bottomHeight}set bottomHeight(e){this._bottomHeight=e,this.onViewUpdate()}get texture(){return this._texture}set texture(e){e||=I.EMPTY;let t=this._texture;t!==e&&(t&&t.dynamic&&t.off(`update`,this.onViewUpdate,this),e.dynamic&&e.on(`update`,this.onViewUpdate,this),this._texture=e,this.onViewUpdate())}get originalWidth(){return this._texture.width}get originalHeight(){return this._texture.height}get trim(){return this._texture.trim??null}onViewUpdate(){super.onViewUpdate(),this._geometryDirty=!0}collectRenderables(e){let t=this._geometry??=new sn;this._geometryDirty&&=(t.update(this),!1);let n=this._batchable;n.texture=this._texture,n.transform=this.groupTransform,n.color=this.groupColorAlpha,n.roundPixels=this._latchRoundPixels(e),n.blendMode=this.groupBlendMode,n.topology=t.topology,n.positions=t.positions,n.uvs=this._batchUvs(t),n.indices=t.indices,n.attributeSize=t.positions.length/2,n.indexSize=t.indices.length,e.addBatchable(n)}_batchUvs(e){let t=e.getBuffer(`aUV`),n=t.data,r=this._texture.textureMatrix;if(r.isSimple)return n;(!this._transformedUvs||this._transformedUvs.length<n.length)&&(this._transformedUvs=new Float32Array(n.length),this._uvKey=``);let i=`${r._updateID}:${t._updateID}:${this._texture.uid}`;return this._uvKey!==i&&(this._uvKey=i,r.multiplyUvs(n,this._transformedUvs)),this._transformedUvs}destroy(e=!1){if(!this.destroyed){if(super.destroy(e),this._texture.dynamic&&this._texture.off(`update`,this.onViewUpdate,this),typeof e==`boolean`?e:e?.texture){let t=typeof e==`boolean`?e:e?.textureSource;this._texture.destroy(t)}this._texture=null,this._geometry?.destroy(),this._geometry=null,this._transformedUvs=null}}updateBounds(){let e=this._bounds,t=this._anchor,n=this._width,r=this._height;e.minX=-t._x*n,e.maxX=e.minX+n,e.minY=-t._y*r,e.maxY=e.minY+r}});function cn(e){return e.startsWith(`depth`)}var z={VERTEX:1,INDEX:2,UNIFORM:4,STORAGE:8,INDIRECT:16,COPY_SRC:32,COPY_DST:64},B={SAMPLED:1,RENDER_TARGET:2,STORAGE:4,COPY_SRC:8,COPY_DST:16},V=class extends Error{constructor(e,t){super(`[RHI:${e}] ${t}`),this.code=e,this.name=`RhiError`}},ln=class{constructor(e){this.onReleaseError=e,this.pending=[],this.recordingDepth=0}beginRecording(){this.recordingDepth++}endRecording(){this.recordingDepth=Math.max(0,this.recordingDepth-1),this.recordingDepth===0&&this.flush()}defer(e){this.recordingDepth>0?this.pending.push(e):this.run(e)}get pendingCount(){return this.pending.length}flush(){let e=this.pending;this.pending=[];for(let t of e)this.run(t)}run(e){try{e()}catch(e){this.onReleaseError(e)}}},un=class{constructor(e,t,n,r){this.kind=e,this.label=t,this.scope=n,this.releases=r,this._destroyed=!1}get destroyed(){return this._destroyed}destroy(){this._destroyed||(this._destroyed=!0,this.scope._untrack(this),this.releases.defer(()=>this.releaseBackend()))}assertAlive(e){if(this._destroyed)throw new V(`destroyed-resource`,`${e}:${this.kind}「${this.label}」已销毁`)}},dn=0,fn=class e{constructor(e,t,n){this.label=e,this.factory=t,this.parent=n,this.resources=new Set,this.children=new Set,this._destroyed=!1,this.id=++dn,n?.children.add(this)}get destroyed(){return this._destroyed}get resourceCount(){return this.resources.size}get childCount(){return this.children.size}createChild(t){return this.assertAlive(),new e(t,this.factory,this)}createBuffer(e){return this.assertAlive(),this.track(this.factory.createBuffer(this,e))}createTexture(e){return this.assertAlive(),this.track(this.factory.createTexture(this,e))}createSampler(e){return this.assertAlive(),this.track(this.factory.createSampler(this,e))}createShader(e){return this.assertAlive(),this.track(this.factory.createShader(this,e))}createRenderPipeline(e){return this.assertAlive(),this.track(this.factory.createRenderPipeline(this,e))}createComputePipeline(e){return this.assertAlive(),this.track(this.factory.createComputePipeline(this,e))}createRenderTarget(e){return this.assertAlive(),this.track(this.factory.createRenderTarget(this,e))}destroy(){if(!this._destroyed){for(let e of[...this.children])e.destroy();for(let e of[...this.resources].reverse())e.destroy();this._destroyed=!0,this.parent?.children.delete(this)}}_invalidateResources(){for(let e of this.children)e._invalidateResources();for(let e of[...this.resources].reverse())e.destroy()}_adopt(e){return this.assertAlive(),this.track(e)}_untrack(e){this.resources.delete(e)}track(e){return this.resources.add(e),e}assertAlive(){if(this._destroyed)throw new V(`destroyed-resource`,`资源作用域「${this.label}」已销毁,不能再创建资源`)}},pn=`core-features-and-limits`,mn=`maxTextureDimension1D.maxTextureDimension2D.maxTextureDimension3D.maxTextureArrayLayers.maxBindGroups.maxBindGroupsPlusVertexBuffers.maxBindingsPerBindGroup.maxDynamicUniformBuffersPerPipelineLayout.maxDynamicStorageBuffersPerPipelineLayout.maxSampledTexturesPerShaderStage.maxSamplersPerShaderStage.maxStorageBuffersPerShaderStage.maxStorageBuffersInVertexStage.maxStorageBuffersInFragmentStage.maxStorageTexturesPerShaderStage.maxStorageTexturesInVertexStage.maxStorageTexturesInFragmentStage.maxUniformBuffersPerShaderStage.maxUniformBufferBindingSize.maxStorageBufferBindingSize.minUniformBufferOffsetAlignment.minStorageBufferOffsetAlignment.maxVertexBuffers.maxBufferSize.maxVertexAttributes.maxVertexBufferArrayStride.maxInterStageShaderVariables.maxColorAttachments.maxColorAttachmentBytesPerSample.maxComputeWorkgroupStorageSize.maxComputeInvocationsPerWorkgroup.maxComputeWorkgroupSizeX.maxComputeWorkgroupSizeY.maxComputeWorkgroupSizeZ.maxComputeWorkgroupsPerDimension.maxImmediateSize`.split(`.`);function hn(e){let t={};for(let n of mn){let r=e[n];typeof r==`number`&&(t[n]=r)}return t}function gn(e){return e.featureLevel??`core`}function _n(e){let t=gn(e),n={featureLevel:t===`compatibility`||t===`best-available`?`compatibility`:`core`};return e.powerPreference&&e.powerPreference!==`default`&&(n.powerPreference=e.powerPreference),e.xrCompatible&&(n.xrCompatible=!0),n}function vn(e,t,n=[]){if(t===`max`)return Array.from(e);let r=[];t===`best-available`&&e.has(pn)&&r.push(pn);for(let t of n){let n=t;e.has(n)&&!r.includes(n)&&r.push(n)}return r}function yn(e,t){return(e===`compatibility`||e===`best-available`)&&t.has(pn)?`core`:e===`best-available`?`compatibility`:e}var bn=new class extends f{type=`webgpu`;isSupported(){return!!(typeof navigator<`u`&&navigator.gpu)}isDeviceHandle(e){return!!(typeof GPUDevice<`u`&&e instanceof GPUDevice||e?.queue)}async create(e){if(!navigator.gpu)throw Error(`WebGPU not available. Recent Chrome browsers should work.`);let n=gn(e),r=_n(e),i=await this.requestGPUAdapter(r);if(!i)throw Error(`Failed to request WebGPU adapter`);let a=i.info||await i.requestAdapterInfo?.(),s={},c=vn(i.features,n,e.optionalFeatures);c.length>0&&(s.requiredFeatures=c),n===`max`&&(s.requiredLimits=hn(i.limits));let l=await i.requestDevice(s),{WebGPUDevice:u}=await t(async()=>{let{WebGPUDevice:e}=await import(`./webgpu-device-CHhU3JO2.js`);return{WebGPUDevice:e}},__vite__mapDeps([0,1])),d=yn(n,l.features),f={...e,featureLevel:d};o.groupCollapsed(1,`WebGPUDevice created`)();try{let e=new u(f,l,i,a);return o.probe(1,`Device created. For more info, set chrome://flags/#enable-webgpu-developer-features`)(),o.table(1,e.info)(),e}finally{o.groupEnd(1)()}}async attach(e){throw Error(`WebGPUAdapter.attach() not implemented`)}requestGPUAdapter(e){return navigator.gpu.requestAdapter(e)}};function xn(e){let t=0;return e&z.VERTEX&&(t|=a.VERTEX),e&z.INDEX&&(t|=a.INDEX),e&z.UNIFORM&&(t|=a.UNIFORM),e&z.STORAGE&&(t|=a.STORAGE),e&z.INDIRECT&&(t|=a.INDIRECT),e&z.COPY_SRC&&(t|=a.COPY_SRC),e&z.COPY_DST&&(t|=a.COPY_DST),t}function Sn(e){let t=0;return e&B.SAMPLED&&(t|=i.SAMPLE),e&B.RENDER_TARGET&&(t|=i.RENDER),e&B.STORAGE&&(t|=i.STORAGE),e&B.COPY_SRC&&(t|=i.COPY_SRC),e&B.COPY_DST&&(t|=i.COPY_DST),t}function Cn(e){return e}function wn(e){return e}function Tn(e){return(e??[]).map(e=>({name:e.name,byteStride:e.stride,stepMode:e.stepMode??`vertex`,attributes:e.attributes.map(e=>({attribute:e.name,format:wn(e.format),byteOffset:e.offset}))}))}function En(e){let t={cullMode:e.cullMode??`none`};return e.blend?(t.blend=!0,t.blendColorSrcFactor=e.blend.color.srcFactor,t.blendColorDstFactor=e.blend.color.dstFactor,t.blendColorOperation=e.blend.color.operation??`add`,t.blendAlphaSrcFactor=e.blend.alpha.srcFactor,t.blendAlphaDstFactor=e.blend.alpha.dstFactor,t.blendAlphaOperation=e.blend.alpha.operation??`add`):t.blend=!1,e.depthFormat&&(t.depthWriteEnabled=e.depth?.write??!0,t.depthCompare=e.depth?.compare??`less-equal`,t.depthFormat=e.depthFormat),e.stencil&&(t.stencilCompare=e.stencil.compare,t.stencilPassOperation=e.stencil.passOp??`keep`,t.stencilFailOperation=e.stencil.failOp??`keep`,t.stencilDepthFailOperation=e.stencil.depthFailOp??`keep`,t.stencilReadMask=e.stencil.readMask??255,t.stencilWriteMask=e.stencil.writeMask??255),e.colorWriteMask!==void 0&&(t.colorMask=e.colorWriteMask),(e.sampleCount??1)>1&&(t.sampleCount=e.sampleCount),t}function Dn(e){let t={id:e.label,addressModeU:e.addressModeU??`clamp-to-edge`,addressModeV:e.addressModeV??`clamp-to-edge`,magFilter:e.magFilter??`linear`,minFilter:e.minFilter??`linear`,mipmapFilter:e.mipmapFilter??`none`};return e.addressModeW!==void 0&&(t.addressModeW=e.addressModeW),e.lodMinClamp!==void 0&&(t.lodMinClamp=e.lodMinClamp),e.lodMaxClamp!==void 0&&(t.lodMaxClamp=e.lodMaxClamp),e.maxAnisotropy!==void 0&&(t.maxAnisotropy=e.maxAnisotropy),e.compare&&(t.type=`comparison-sampler`,t.compare=e.compare),t}function On(e,t,n,r,i){let a=t*r;if(i===a)return e.slice(0,a*n);let o=new Uint8Array(a*n);for(let t=0;t<n;t++)o.set(e.subarray(t*i,t*i+a),t*a);return o}var kn=`
var<private> pos : array<vec2<f32>, 3> = array<vec2<f32>, 3>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(-1.0, 3.0), vec2<f32>(3.0, -1.0));

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) texCoord : vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var output : VertexOutput;
  output.texCoord = pos[vertexIndex] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
  return output;
}

@group(0) @binding(0) var imgSampler : sampler;
@group(0) @binding(1) var img : texture_2d<f32>;

@fragment
fn fragmentMain(@location(0) texCoord : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(img, imgSampler, texCoord);
}
`,An=class{constructor(e){this.device=e,this.module=null,this.sampler=null,this.pipelines=new Map}pipelineFor(e){let t=this.pipelines.get(e);return t||(this.module??=this.device.createShaderModule({label:`rhi-mipmap`,code:kn}),t=this.device.createRenderPipeline({label:`rhi-mipmap:${e}`,layout:`auto`,vertex:{module:this.module,entryPoint:`vertexMain`},fragment:{module:this.module,entryPoint:`fragmentMain`,targets:[{format:e}]}}),this.pipelines.set(e,t)),t}generate(e){if(e.mipLevelCount<=1)return;if(e.dimension!==`2d`)throw Error(`只支持 2D 纹理生成 mip(当前 ${e.dimension})`);let t=this.pipelineFor(e.format);this.sampler??=this.device.createSampler({label:`rhi-mipmap`,minFilter:`linear`});let n=t.getBindGroupLayout(0),r=this.device.createCommandEncoder({label:`rhi-mipmap`}),i=e.depthOrArrayLayers||1;for(let a=0;a<i;a++){let i=e.createView({dimension:`2d`,baseMipLevel:0,mipLevelCount:1,baseArrayLayer:a,arrayLayerCount:1});for(let o=1;o<e.mipLevelCount;o++){let s=e.createView({dimension:`2d`,baseMipLevel:o,mipLevelCount:1,baseArrayLayer:a,arrayLayerCount:1}),c=r.beginRenderPass({colorAttachments:[{view:s,loadOp:`clear`,storeOp:`store`,clearValue:{r:0,g:0,b:0,a:0}}]});c.setPipeline(t),c.setBindGroup(0,this.device.createBindGroup({layout:n,entries:[{binding:0,resource:this.sampler},{binding:1,resource:i}]})),c.draw(3,1,0,0),c.end(),i=s}}this.device.queue.submit([r.finish()])}},jn=`Sampler`;function Mn(e,t){return(RegExp(`@${t}(?:\\s+@workgroup_size\\([^)]*\\))?\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(e)??RegExp(`@workgroup_size\\([^)]*\\)\\s+@${t}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(e))?.[1]}function Nn(e){if(!e.wgsl)throw new V(`invalid-usage`,`着色器「${e.label}」没有 WGSL 源`);let t={vertex:e.entryPoints?.vertex??Mn(e.wgsl,`vertex`),fragment:e.entryPoints?.fragment??Mn(e.wgsl,`fragment`),compute:e.entryPoints?.compute??Mn(e.wgsl,`compute`)};if(!t.vertex&&!t.fragment&&!t.compute)throw new V(`invalid-usage`,`着色器「${e.label}」里找不到 @vertex / @fragment / @compute 入口`);return t}function Pn(e,t){return e.filter(e=>t[e]===void 0?e.endsWith(`Sampler`)?t[e.slice(0,-7)]?.kind!==`texture`:!0:!1)}function Fn(e){let t=e.requestDevice.bind(e);return e.requestDevice=(n={})=>t({...n,requiredLimits:{...n.requiredLimits,maxTextureDimension2D:e.limits.maxTextureDimension2D}}),e}var In=Object.create(bn,{requestGPUAdapter:{value:async e=>{let t=await globalThis.navigator.gpu.requestAdapter(e);return t&&Fn(t)}}});async function Ln(e){if(!globalThis.navigator?.gpu)throw new V(`unsupported`,`此环境没有 WebGPU(navigator.gpu 不存在;需要 https 或 localhost,且浏览器 / WebView 开启 WebGPU)`);let t={target:null,early:[]},n=async()=>{try{return await d.createDevice({type:`webgpu`,adapters:[In],createCanvasContext:{canvas:e.canvas,alphaMode:e.alphaMode??`opaque`,useDevicePixels:e.useDevicePixels??!0,autoResize:e.autoResize??!0},debug:e.debug??!1,debugShaders:e.debug?`errors`:`never`,onError:e=>{t.target?t.target._reportBackendError(e):t.early.push(e)}})}catch(e){throw new V(`unsupported`,`WebGPU 设备创建失败:${e instanceof Error?e.message:String(e)}`)}},r=new sr(await n(),{recreateDevice:n});t.target=r;for(let e of t.early)r._reportBackendError(e);return r}var Rn=[0,250,1e3,2e3,4e3,8e3];function zn(e){let t=e.limits;return{float32Filterable:e.isTextureFormatFilterable(`rgba32float`),maxTextureSize:t.maxTextureDimension2D,maxColorAttachments:t.maxColorAttachments,maxComputeWorkgroupSize:[t.maxComputeWorkgroupSizeX,t.maxComputeWorkgroupSizeY,t.maxComputeWorkgroupSizeZ],maxComputeInvocationsPerWorkgroup:t.maxComputeInvocationsPerWorkgroup,swapchainFormat:e.preferredColorFormat}}function Bn(e){return e instanceof Error?e.message:String(e)}var Vn=class extends un{constructor(e,t,n,r,i,a,o){super(`buffer`,o,e,t),this.handle=n,this.size=r,this.usage=i,this.indexFormat=a}releaseBackend(){this.handle.destroy()}},Hn=class extends un{constructor(e,t,n,r,i,a=!1){super(`texture`,i,e,t),this.handle=n,this.usage=r,this.external=a}get width(){return this.handle.width}get height(){return this.handle.height}get format(){return this.handle.format}get mipLevels(){return this.handle.mipLevels}get sampleCount(){return this.handle.samples??1}releaseBackend(){this.handle.destroy()}},Un=class extends un{constructor(e,t,n,r){super(`sampler`,r,e,t),this.handle=n}releaseBackend(){this.handle.destroy()}},Wn=class extends un{constructor(e,t,n,r,i,a){super(`shader`,n,e,t),this.module=r,this.entryPoints=i,this.creationError=a}get hasRender(){return this.entryPoints.vertex!=null&&this.entryPoints.fragment!=null}get hasCompute(){return this.entryPoints.compute!=null}releaseBackend(){this.module.destroy()}},Gn=class{constructor(e,t){this.isReady=!1,this.failed=!1,this.ready=e.then(()=>{this.isReady=!0},e=>{throw this.failed=!0,e}),this.ready.catch(t)}},Kn=class extends un{constructor(e,t,n,r,i,a,o,s,c,l,u,d){super(`render-pipeline`,n,e,t),this.handle=r,this.vertexArray=i,this.streamSlots=a,this.colorFormats=o,this.depthFormat=s,this.sampleCount=c,this.streamNames=[...a.keys()];let f=cr(i,n),p=[...a.values()];this.vertexSlotStream=f.map(e=>p.indexOf(e.logicalSlot)),this.vertexSlotOffset=f.map(e=>e.bindingOffset),this.bindings=new nr(r.shaderLayout),this.state=new Gn(ur(n,[r],l,[u]),d)}get ready(){return this.state.ready}get isReady(){return this.state.isReady}get failed(){return this.state.failed}releaseBackend(){this.vertexArray.destroy(),this.handle.destroy()}},qn=class extends un{constructor(e,t,n,r,i,a,o){super(`compute-pipeline`,n,e,t),this.handle=r,this.bindings=new nr(r.shaderLayout),this.state=new Gn(ur(n,[],i,[a]),o)}get ready(){return this.state.ready}get isReady(){return this.state.isReady}get failed(){return this.state.failed}releaseBackend(){this.handle.destroy()}},Jn=class extends un{constructor(e,t,n,r,i,a,o=[],s=new Map){super(`render-target`,n,e,t),this.framebuffer=r,this.colors=i,this.depth=a,this.resolves=o,this.levelViews=s,this.formats=null}get sampleCount(){return(this.colors[0]??this.depth)?.sampleCount??1}resolveView(e){let t=this.resolves[e];if(!t)return;let n=this.levelViews.get(t);return n?n.handle:t.handle.view.handle}get width(){return this.framebuffer.width}get height(){return this.framebuffer.height}get colorFormats(){return this.formats??=this.colors.map(e=>e.format)}get depthFormat(){return this.depth?.format??null}assertAlive(e){super.assertAlive(e);for(let t of this.colors)t.assertAlive(`${e}(渲染目标「${this.label}」的颜色附件)`);this.depth?.assertAlive(`${e}(渲染目标「${this.label}」的深度附件)`);for(let t of this.resolves)t?.assertAlive(`${e}(渲染目标「${this.label}」的 resolve 目标)`)}releaseBackend(){this.framebuffer.destroy();for(let e of this.levelViews.values())e.destroy()}};function Yn(e){let t=e.getCurrentFramebuffer({depthStencilFormat:!1}),n=e;return n.depthStencilAttachment&&=(n.depthStencilAttachment.destroy(),null),t}var Xn=class extends un{constructor(e,t,n,r,i,a=null){super(`render-target`,a?`画布后备缓冲+${a}`:`画布后备缓冲`,e,t),this.luma=n,this.context=r,this.format=i,this.depth=a,this.armed=!1,this.formats=null,this.views=null,this.depthTex=null}get canvasFramebuffer(){if(!this.armed)throw new V(`invalid-usage`,`画布后备缓冲只能在 runFrame 的录制期内使用`);return Yn(this.context)}passViews(){if(!this.views){let e=this.canvasFramebuffer;this.views={color:e.colorAttachments[0].handle,depth:this.depth?this.depthView(this.depth,e.width,e.height):null}}return this.views}depthView(e,t,n){let r=this.depthTex;return(!r||r.width!==t||r.height!==n)&&(r?.destroy(),r=this.depthTex=this.luma.createTexture({id:`${this.label} 深度`,width:t,height:n,format:Cn(e),usage:Sn(B.RENDER_TARGET)})),r.view.handle}get width(){return this.context.getDrawingBufferSize()[0]}get height(){return this.context.getDrawingBufferSize()[1]}get colorFormats(){return this.formats??=[this.format]}get depthFormat(){return this.depth}get sampleCount(){return 1}destroy(){throw new V(`invalid-usage`,`画布后备缓冲归设备所有,不能单独销毁`)}_beginFrame(){this.armed=!0,this.views=null}_endFrame(){this.armed=!1,this.views=null}releaseTextures(){this.depthTex?.destroy(),this.depthTex=null}releaseBackend(){this.releaseTextures()}},Zn=class{constructor(e,t,n,r){this.luma=e,this.label=t,this.format=n,this.sampleCount=r,this.texture=null,this.generation=0}ensure(e,t){let n=this.texture;return n&&n.width===e&&n.height===t?n:(n?.destroy(),this.generation++,this.texture=this.luma.createTexture({id:this.label,width:e,height:t,format:Cn(this.format),usage:Sn(B.RENDER_TARGET),samples:this.sampleCount}))}release(){this.texture?.destroy(),this.texture=null}},Qn=class extends un{constructor(e,t,n,r,i,a,o){super(`render-target`,`画布后备缓冲 MSAA×${a.sampleCount}${o?`+${o}`:``}`,e,t),this.luma=n,this.context=r,this.format=i,this.colorStore=a,this.depth=o,this.armed=!1,this.formats=null,this.depthTex=null,this.fb=null,this.fbGeneration=-1}get sampleCount(){return this.colorStore.sampleCount}get canvasFramebuffer(){if(!this.armed)throw new V(`invalid-usage`,`画布后备缓冲只能在 runFrame 的录制期内使用`);return Yn(this.context)}get resolveView(){return this.canvasFramebuffer.colorAttachments[0].handle}get framebuffer(){let e=this.canvasFramebuffer,t=e.width,n=e.height,r=this.colorStore.ensure(t,n);return(!this.fb||this.fbGeneration!==this.colorStore.generation)&&(this.releaseOwn(),this.depthTex=this.depth?this.luma.createTexture({id:`${this.label} 深度`,width:t,height:n,format:Cn(this.depth),usage:Sn(B.RENDER_TARGET),samples:this.sampleCount}):null,this.fb=this.luma.createFramebuffer({id:this.label,width:t,height:n,colorAttachments:[r],depthStencilAttachment:this.depthTex}),this.fbGeneration=this.colorStore.generation),this.fb}get width(){return this.context.getDrawingBufferSize()[0]}get height(){return this.context.getDrawingBufferSize()[1]}get colorFormats(){return this.formats??=[this.format]}get depthFormat(){return this.depth}destroy(){throw new V(`invalid-usage`,`画布后备缓冲归设备所有,不能单独销毁`)}_beginFrame(){this.armed=!0}_endFrame(){this.armed=!1}releaseOwn(){this.fb?.destroy(),this.depthTex?.destroy(),this.fb=null,this.depthTex=null,this.fbGeneration=-1}releaseTextures(){this.releaseOwn()}releaseBackend(){this.releaseOwn()}},$n=1024;function er(e,t){let n=e.objects??=new WeakMap,r=n.get(t);return r||n.set(t,r={}),r}function tr(e,t){let n=e.numbers??=new Map,r=n.get(t);return r||n.set(t,r={}),r}var nr=class{constructor(e){this.root={},this.entries=0,this.names=e.bindings.map(e=>e.name);let t=new Set(this.names);this.pairedSampler=this.names.map(e=>e+jn),this.pairedSamplerDeclared=this.pairedSampler.map(e=>t.has(e)),this.textureOf=this.names.map(e=>e.endsWith(`Sampler`)?e.slice(0,-jn.length):null)}resolve(e,t,n,r,i){this.entries>=$n&&(this.root={},this.entries=0);let a=this.root,o=this.names;for(let e=0;e<o.length;e++){let t=o[e],s=n[t],c=this.textureOf[e];if(c!==null&&(s===void 0||s instanceof Un)&&n[c]instanceof Hn){s!==void 0&&s.destroyed&&s.assertAlive(`管线「${r}」绑定 ${t}`);continue}if(s===void 0)throw new V(`invalid-usage`,`管线「${r}」:着色器需要的绑定没给 —— ${Pn(o,n).join(`, `)}`);if(s instanceof Hn){s.destroyed&&s.assertAlive(`管线「${r}」绑定 ${t}`);let o=n[this.pairedSampler[e]];o instanceof Un&&(o.destroyed&&o.assertAlive(`管线「${r}」绑定 ${this.pairedSampler[e]}`),s.handle.sampler!==o.handle&&s.handle.setSampler(o.handle)),i._use(s),a=er(a,s),this.pairedSamplerDeclared[e]&&(a=er(a,s.handle.sampler))}else if(s instanceof Vn||s instanceof Un)s.destroyed&&s.assertAlive(`管线「${r}」绑定 ${t}`),s instanceof Vn&&i._use(s),a=er(a,s);else if(typeof s==`object`&&s&&`buffer`in s){let e=s.buffer;if(!(e instanceof Vn))throw new V(`invalid-usage`,`管线「${r}」绑定 ${t}:不是本设备的缓冲`);e.destroyed&&e.assertAlive(`管线「${r}」绑定 ${t}`),i._use(e),a=tr(tr(er(a,e),s.offset??-1),s.size??-1)}else throw new V(`invalid-usage`,`管线「${r}」绑定 ${t}:不认识的绑定资源`)}return a.groups||(a.groups=e._createBindGroups(t,this.toLuma(n)),this.entries++),a.groups}toLuma(e){let t={};for(let n=0;n<this.names.length;n++){let r=this.names[n],i=e[r],a=this.textureOf[n];a!==null&&(i===void 0||i instanceof Un)&&e[a]instanceof Hn||(i instanceof Vn||i instanceof Hn||i instanceof Un?t[r]=i.handle:typeof i==`object`&&i&&`buffer`in i&&(t[r]={buffer:i.buffer.handle,offset:i.offset,size:i.size}))}return t}},rr=class{constructor(e,t,n){this.device=e,this.label=t,this.stats=n,this.lumaEncoder=null,this.openPass=null,this.used=new Set,this.native=e.gpuDevice.createCommandEncoder({label:t})}get encoder(){return this.lumaEncoder??=this.device.luma.createCommandEncoder({id:this.label,handle:this.native})}beginRenderPass(e){this.assertNoOpenPass(`beginRenderPass「${e.label}」`);let t=_r(e.target);if(t.assertAlive(`render pass「${e.label}」的目标`),t instanceof Jn){for(let e of t.colors)this._use(e);t.depth&&this._use(t.depth);for(let e of t.resolves)e&&this._use(e)}let n=e.colorOps??[];if(n.length>t.colorFormats.length)throw new V(`invalid-usage`,`render pass「${e.label}」给了 ${n.length} 个颜色附件操作,目标只有 ${t.colorFormats.length} 个附件`);let r=t instanceof Xn?t.passViews():null,i=r?{colorAttachments:[{handle:r.color}],depthStencilAttachment:r.depth?{handle:r.depth}:null}:t.framebuffer,a=t.colorFormats.map((e,r)=>{let a=n[r]??{load:`clear`},o=a.load===`clear`?a.clearValue??[0,0,0,0]:[0,0,0,0],s=t instanceof Jn?t.resolveView(r):t instanceof Qn&&r===0?t.resolveView:void 0;return{view:i.colorAttachments[r].handle,...s?{resolveTarget:s}:{},loadOp:a.load,storeOp:`store`,clearValue:e.endsWith(`uint`)?o.map(e=>Math.trunc(e)):o}}),o,s=t.depthFormat;if(s&&i.depthStencilAttachment){let t=e.depthOp??{load:`clear`};if(o={view:i.depthStencilAttachment.handle,depthLoadOp:t.load,depthStoreOp:`store`,depthClearValue:t.load===`clear`?t.clearValue??1:void 0},s.includes(`stencil`)){let t=e.stencilOp??{load:`clear`};o.stencilLoadOp=t.load,o.stencilStoreOp=`store`,t.load===`clear`&&(o.stencilClearValue=t.clearValue??0)}}let c=this.native.beginRenderPass({label:e.label,colorAttachments:a,depthStencilAttachment:o});this.stats.renderPasses++;let l=new ir(this.device,this,c,t,e.label,this.stats);return this.openPass=l,l}beginComputePass(e){this.assertNoOpenPass(`beginComputePass「${e}」`);let t=this.encoder.beginComputePass({id:e});this.stats.computePasses++;let n=new ar(this.device,this,t,e,this.stats);return this.openPass=n,n}copyBufferToBuffer(e,t,n,r,i){this.assertNoOpenPass(`copyBufferToBuffer`);let a=pr(e,`copyBufferToBuffer 源`),o=pr(n,`copyBufferToBuffer 目标`);if(fr(a.usage,z.COPY_SRC,`缓冲「${a.label}」作拷贝源`,`COPY_SRC`),fr(o.usage,z.COPY_DST,`缓冲「${o.label}」作拷贝目标`,`COPY_DST`),this._use(a),this._use(o),t<0||r<0||t+i>a.size||r+i>o.size)throw new V(`invalid-usage`,`copyBufferToBuffer 越界:源「${a.label}」[${t}, +${i}) / 目标「${o.label}」[${r}, +${i})`);this.encoder.copyBufferToBuffer({sourceBuffer:a.handle,sourceOffset:t,destinationBuffer:o.handle,destinationOffset:r,size:i})}copyTextureToTexture(e,t,n,r){this.assertNoOpenPass(`copyTextureToTexture`);let i=mr(e,`copyTextureToTexture 源`),a=mr(t,`copyTextureToTexture 目标`);fr(i.usage,B.COPY_SRC,`纹理「${i.label}」作拷贝源`,`COPY_SRC`),fr(a.usage,B.COPY_DST,`纹理「${a.label}」作拷贝目标`,`COPY_DST`),this._use(i),this._use(a);let o=n??i.width,s=r??i.height;if(o>i.width||s>i.height||o>a.width||s>a.height)throw new V(`invalid-usage`,`copyTextureToTexture 越界:${o}×${s},源「${i.label}」${i.width}×${i.height},目标「${a.label}」${a.width}×${a.height}`);if(i.format!==a.format)throw new V(`invalid-usage`,`copyTextureToTexture 格式不同:「${i.label}」${i.format} → 「${a.label}」${a.format}`);this.encoder.copyTextureToTexture({sourceTexture:i.handle,destinationTexture:a.handle,width:o,height:s})}pushDebugGroup(e){this.assertNoOpenPass(`pushDebugGroup「${e}」`),this.encoder.pushDebugGroup(e)}popDebugGroup(){this.assertNoOpenPass(`popDebugGroup`),this.encoder.popDebugGroup()}_use(e){this.used.add(e)}_uses(e){return this.used.has(e)}_passEnded(){this.openPass=null}_submit(){this.assertNoOpenPass(`提交「${this.label}」`);let e=this.native.finish();this.lumaEncoder?.destroy(),this.lumaEncoder=null,this.device.gpuDevice.queue.submit([e])}_abandon(){try{this.openPass?.end()}catch{}this.openPass=null;try{this.lumaEncoder?.destroy()}catch{}this.lumaEncoder=null}assertNoOpenPass(e){if(this.openPass)throw new V(`invalid-usage`,`${e}:上一个 pass 还没 end()`)}},ir=class{constructor(e,t,n,r,i,a){this.device=e,this.list=t,this.native=n,this.target=r,this.label=i,this.stats=a,this.pipeline=null,this.bindingsSet=!1,this.skipping=!1,this.streams=new Map,this.indexBuffer=null,this.ended=!1,this.boundPipeline=null,this.boundGroups=[],this.boundVertex=[],this.boundVertexOffset=[],this.boundIndex=null,this.boundIndexFormat=null,this.drawStreams=[]}setPipeline(e){if(!(e instanceof Kn))throw new V(`invalid-usage`,`render pass「${this.label}」setPipeline:不是本设备的渲染管线`);let t=e;if(t.destroyed&&t.assertAlive(`render pass「${this.label}」setPipeline`),t.sampleCount!==this.target.sampleCount)throw new V(`invalid-usage`,`管线「${t.label}」的采样数 ${t.sampleCount} 与 render pass「${this.label}」的目标(${this.target.sampleCount})不一致`);if(!dr(t.colorFormats,this.target.colorFormats)||t.depthFormat!==this.target.depthFormat)throw new V(`invalid-usage`,`管线「${t.label}」的目标格式 [${t.colorFormats.join(`, `)}|${t.depthFormat??`无深度`}] 与 render pass「${this.label}」的目标 [${this.target.colorFormats.join(`, `)}|${this.target.depthFormat??`无深度`}] 不一致`);if(this.skipping=t.failed,!this.skipping){let e=t.handle.handle;e!==this.boundPipeline&&(this.native.setPipeline(e),this.boundPipeline=e)}this.pipeline=t,this.bindingsSet=!1}setBindings(e){let t=this.requirePipeline(`setBindings`);if(this.skipping){this.bindingsSet=!0;return}let n=t.bindings.resolve(this.device,t.handle,e,t.label,this.list);for(let e=0;e<n.length;e++){let t=n[e];t&&t!==this.boundGroups[e]&&(this.native.setBindGroup(e,t),this.boundGroups[e]=t)}this.bindingsSet=!0}setVertexBuffer(e,t){if(!(t instanceof Vn))throw new V(`invalid-usage`,`顶点流「${e}」:不是本设备的缓冲`);let n=t;n.destroyed&&n.assertAlive(`顶点流「${e}」`),(n.usage&z.VERTEX)===0&&fr(n.usage,z.VERTEX,`缓冲「${n.label}」作顶点流`,`VERTEX`),this.list._use(n),this.streams.set(e,n)}setIndexBuffer(e){if(e==null){this.indexBuffer=null;return}if(!(e instanceof Vn))throw new V(`invalid-usage`,`索引缓冲:不是本设备的缓冲`);let t=e;if(t.assertAlive(`索引缓冲`),(t.usage&z.INDEX)===0&&fr(t.usage,z.INDEX,`缓冲「${t.label}」作索引`,`INDEX`),!t.indexFormat)throw new V(`invalid-usage`,`索引缓冲「${t.label}」创建时没给 indexFormat`);this.list._use(t),this.indexBuffer=t}setViewport(e,t,n,r){this.native.setViewport(e,t,n,r,0,1)}setScissor(e,t,n,r){this.native.setScissorRect(e,t,n,r)}setStencilReference(e){this.native.setStencilReference(e)}draw(e,t=1,n=0,r=0){let i=this.prepareDraw(!1);i&&(this.native.draw(e,t,n,r),this.count(i,!0))}drawIndexed(e,t=1,n=0,r=0,i=0){let a=this.prepareDraw(!0);a&&(this.native.drawIndexed(e,t,n,r,i),this.count(a,!0))}end(){this.ended||(this.ended=!0,this.native.end(),this.list._passEnded())}requirePipeline(e){let t=this.pipeline;if(!t)throw new V(`invalid-usage`,`render pass「${this.label}」${e}:还没 setPipeline`);return t.destroyed&&t.assertAlive(`render pass「${this.label}」${e}`),t}prepareDraw(e){let t=this.requirePipeline(`draw`);if(this.skipping)return this.count(t,!1),null;if(!this.bindingsSet&&t.handle.shaderLayout.bindings.length>0)throw new V(`invalid-usage`,`管线「${t.label}」需要资源绑定:setPipeline 之后先 setBindings 再 draw`);let n=t.streamNames,r=this.drawStreams;for(let e=0;e<n.length;e++){let i=this.streams.get(n[e]);if(!i)throw new V(`invalid-usage`,`管线「${t.label}」的顶点流「${n[e]}」没绑定缓冲`);i.destroyed&&i.assertAlive(`顶点流「${n[e]}」`),r[e]=i}if(e){let e=this.indexBuffer;if(!e)throw new V(`invalid-usage`,`drawIndexed 之前没 setIndexBuffer(管线「${t.label}」)`);e.assertAlive(`索引缓冲`);let n=e.handle.handle,r=e.indexFormat;(n!==this.boundIndex||r!==this.boundIndexFormat)&&(this.native.setIndexBuffer(n,r),this.boundIndex=n,this.boundIndexFormat=r)}let i=t.vertexSlotStream;for(let e=0;e<i.length;e++){let n=i[e];if(n<0)continue;let a=r[n].handle.handle,o=t.vertexSlotOffset[e];(a!==this.boundVertex[e]||o!==this.boundVertexOffset[e])&&(this.native.setVertexBuffer(e,a,o),this.boundVertex[e]=a,this.boundVertexOffset[e]=o)}return r.length=0,t}count(e,t){t?this.stats.draws++:(this.stats.skippedDraws++,this.device._warnSkippedDraw(e))}},ar=class{constructor(e,t,n,r,i){this.device=e,this.list=t,this.pass=n,this.label=r,this.stats=i,this.pipeline=null,this.bindingsSet=!1,this.skipping=!1,this.ended=!1}setPipeline(e){let t=gr(e,`compute pass「${this.label}」setPipeline`);this.skipping=t.failed,this.skipping||this.pass.setPipeline(t.handle),this.pipeline=t,this.bindingsSet=!1}setBindings(e){let t=this.pipeline;if(!t)throw new V(`invalid-usage`,`compute pass「${this.label}」setBindings:还没 setPipeline`);if(this.skipping){this.bindingsSet=!0;return}let n=t.bindings.resolve(this.device,t.handle,e,t.label,this.list),r=this.pass.handle;for(let e=0;e<n.length;e++){let t=n[e];t&&r.setBindGroup(e,t)}this.bindingsSet=!0}dispatch(e,t=1,n=1){if(!this.pipeline)throw new V(`invalid-usage`,`compute pass「${this.label}」dispatch:还没 setPipeline`);if(this.pipeline.assertAlive(`compute pass「${this.label}」dispatch`),this.skipping){this.device._warnSkippedDraw(this.pipeline);return}if(!this.bindingsSet&&this.pipeline.handle.shaderLayout.bindings.length>0)throw new V(`invalid-usage`,`管线「${this.pipeline.label}」需要资源绑定:setPipeline 之后先 setBindings 再 dispatch`);this.pass.dispatch(e,t,n),this.stats.dispatches++}end(){this.ended||(this.ended=!0,this.pass.end(),this.list._passEnded())}};function or(e){return{frame:e,renderPasses:0,computePasses:0,draws:0,dispatches:0,skippedDraws:0}}var sr=class{constructor(e,t={}){this.recovery=t,this._isLost=!1,this.pendingReadbacks=new Set,this.listeners=new Set,this.restoredListeners=new Set,this.restoring=!1,this.canvasReleased=!1,this.swapchainSize=null,this.swapchainDepth=new Map,this.swapchainMsaa=new Map,this.swapchainMsaaColors=new Map,this.warnedSkips=new WeakSet,this.frameIndex=0,this.recordings=[],this._lastFrameStats=or(-1),this._destroyed=!1,this.mipmaps=null,this._luma=e,this.caps=zn(e),this.info={vendor:e.info.vendor,renderer:e.info.renderer},this.releases=new ln(e=>this.report(e,`error`)),this.rootScope=new fn(`设备`,this,null),this.swapchain=new Xn(this.rootScope,this.releases,e,e.getDefaultCanvasContext(),this.caps.swapchainFormat),this.watchLoss(e)}get luma(){return this._luma}get gpuDevice(){return this._luma.handle}get isLost(){return this._isLost}get lost(){return this._lost}onRestored(e){return this.restoredListeners.add(e),()=>this.restoredListeners.delete(e)}get lastFrameStats(){return this._lastFrameStats}get native(){let e=this.luma;return{adapter:e.adapter?.handle??e.adapter,device:e.handle,gpuTexture:e=>mr(e,`native.gpuTexture`).handle.handle,wrapTexture:(e,t)=>{let n=t.texture,r=this.luma.createTexture({id:t.label,handle:n,width:n.width,height:n.height,format:n.format,mipLevels:n.mipLevelCount,usage:n.usage,sampler:Dn({})});return e._adopt(new Hn(e,this.releases,r,lr(n.usage),t.label,!0))}}}createScope(e,t=this.rootScope){return t.createChild(e)}createBuffer(e,t){let n=t.size??t.data?.byteLength??0;if(!(n>0))throw new V(`invalid-usage`,`缓冲「${t.label}」大小必须 > 0`);if(t.data&&t.data.byteLength>n)throw new V(`invalid-usage`,`缓冲「${t.label}」的初始数据(${t.data.byteLength} 字节)超过大小 ${n}`);if(t.usage&z.INDEX&&!t.indexFormat)throw new V(`invalid-usage`,`索引缓冲「${t.label}」要给 indexFormat`);let r=this.luma.createBuffer({id:t.label,usage:xn(t.usage),byteLength:n,data:t.data??null,indexType:t.indexFormat});return new Vn(e,this.releases,r,n,t.usage,t.indexFormat,t.label)}createTexture(e,t){if(t.flipY)throw vr(t.label);if(!(t.width>0&&t.height>0))throw new V(`invalid-usage`,`纹理「${t.label}」尺寸非法:${t.width}×${t.height}`);if(t.width>this.caps.maxTextureSize||t.height>this.caps.maxTextureSize)throw new V(`unsupported`,`纹理「${t.label}」${t.width}×${t.height} 超过设备上限 ${this.caps.maxTextureSize}`);if(t.usage&B.RENDER_TARGET&&!cn(t.format)&&!this.luma.isTextureFormatRenderable(Cn(t.format)))throw new V(`unsupported`,`纹理「${t.label}」的格式 ${t.format} 在当前后端不能当渲染目标`);let n=t.sampleCount??1;if(n!==1&&n!==4)throw new V(`unsupported`,`纹理「${t.label}」的采样数 ${n} 不支持(WebGPU 只有 1 / 4)`);if(n>1){if(t.usage!==B.RENDER_TARGET)throw new V(`invalid-usage`,`多重采样纹理「${t.label}」只能当渲染附件(用途只许 RENDER_TARGET),画完 resolve 到单采样纹理再采样 / 拷贝`);if(t.data!=null||(t.mipLevels??1)!==1)throw new V(`invalid-usage`,`多重采样纹理「${t.label}」不能带初始数据、不能多级 mip`)}let r=t.data!=null&&!ArrayBuffer.isView(t.data),i=t.usage;t.data!=null&&(i|=B.COPY_DST),r&&(i|=B.RENDER_TARGET);let a=this.luma.createTexture({id:t.label,width:t.width,height:t.height,format:Cn(t.format),usage:Sn(i),mipLevels:t.mipLevels??1,...n>1?{samples:n}:{},sampler:Dn(t.sampler??{})}),o=new Hn(e,this.releases,a,i,t.label);return r?this.uploadImage(o,t.data,{premultiplyAlpha:t.premultiplyAlpha}):t.data!=null&&this.writeTexture(o,t.data),o}createSampler(e,t){let n=this.luma.createSampler(Dn(t));return new Un(e,this.releases,n,t.label??`sampler`)}createShader(e,t){let n=Nn(t),[r,i]=this.captureErrors(()=>this.luma.createShader({id:t.label,source:t.wgsl,language:`wgsl`}));return new Wn(e,this.releases,t.label,r,n,i)}createRenderPipeline(e,t){let n=hr(t.shader,`管线「${t.label}」`);if(!n.hasRender)throw new V(`invalid-usage`,`管线「${t.label}」:着色器「${n.label}」没有顶点 + 片元入口`);if(t.colorFormats.length>this.caps.maxColorAttachments)throw new V(`unsupported`,`管线「${t.label}」要 ${t.colorFormats.length} 个颜色附件,设备上限 ${this.caps.maxColorAttachments}`);let r=Tn(t.vertexBuffers),[i,a]=this.captureErrors(()=>this.luma.createRenderPipeline({id:t.label,vs:n.module,fs:n.module,vertexEntryPoint:n.entryPoints.vertex,fragmentEntryPoint:n.entryPoints.fragment,bufferLayout:r,topology:t.topology??`triangle-list`,colorAttachmentFormats:t.colorFormats.map(Cn),parameters:En(t)})),o=this.luma.createVertexArray({shaderLayout:i.shaderLayout,bufferLayout:r}),s=this.resolveStreamSlots(o,t);return new Kn(e,this.releases,t.label,i,o,s,[...t.colorFormats],t.depthFormat??null,t.sampleCount??1,[n],a,e=>this.report(e,`error`))}createComputePipeline(e,t){let n=hr(t.shader,`计算管线「${t.label}」`);if(!n.hasCompute)throw new V(`invalid-usage`,`计算管线「${t.label}」:着色器「${n.label}」没有计算入口`);let[r,i]=this.captureErrors(()=>this.luma.createComputePipeline({id:t.label,shader:n.module,entryPoint:n.entryPoints.compute}));return new qn(e,this.releases,t.label,r,[n],i,e=>this.report(e,`error`))}createRenderTarget(e,t){if(t.colors.length===0&&!t.depth)throw new V(`invalid-usage`,`渲染目标「${t.label}」至少要一个附件`);let n=t.colors.map((e,n)=>mr(e,`渲染目标「${t.label}」颜色附件 ${n}`)),r=t.depth?mr(t.depth,`渲染目标「${t.label}」深度附件`):null,i=r?[...n,r]:n,{width:a,height:o}=i[0];for(let e of i){if(e.width!==a||e.height!==o)throw new V(`invalid-usage`,`渲染目标「${t.label}」附件尺寸不一致:「${e.label}」${e.width}×${e.height} ≠ ${a}×${o}`);fr(e.usage,B.RENDER_TARGET,`纹理「${e.label}」作附件`,`RENDER_TARGET`)}for(let e of n)if(cn(e.format))throw new V(`invalid-usage`,`「${e.label}」是深度格式,不能当颜色附件`);if(r&&!cn(r.format))throw new V(`invalid-usage`,`「${r.label}」不是深度格式,不能当深度附件`);let s=i[0].sampleCount;for(let e of i)if(e.sampleCount!==s)throw new V(`invalid-usage`,`渲染目标「${t.label}」附件采样数不一致:「${e.label}」${e.sampleCount} ≠ ${s}`);let c=(t.resolveTargets??[]).map((e,r)=>{if(!e)return null;let i=mr(e,`渲染目标「${t.label}」resolve 目标 ${r}`),s=n[r];if(!s)throw new V(`invalid-usage`,`渲染目标「${t.label}」的 resolve 目标 ${r} 没有对应的颜色附件`);if(s.sampleCount===1)throw new V(`invalid-usage`,`渲染目标「${t.label}」颜色附件 ${r} 不是多重采样,不需要 resolve`);if(i.sampleCount!==1)throw new V(`invalid-usage`,`resolve 目标「${i.label}」必须是单采样纹理`);if(i.width!==a||i.height!==o||i.format!==s.format)throw new V(`invalid-usage`,`resolve 目标「${i.label}」须与附件「${s.label}」同尺寸同格式`);return fr(i.usage,B.RENDER_TARGET,`纹理「${i.label}」作 resolve 目标`,`RENDER_TARGET`),i}),l=new Map;for(let e of[...n,...c])e&&e.mipLevels>1&&!l.has(e)&&l.set(e,e.handle.createView({dimension:`2d`,baseMipLevel:0,mipLevelCount:1,arrayLayerCount:1}));let u=this.luma.createFramebuffer({id:t.label,width:a,height:o,colorAttachments:n.map(e=>l.get(e)??e.handle),depthStencilAttachment:r?.handle??null});return new Jn(e,this.releases,t.label,u,n,r,c,l)}writeBuffer(e,t,n=0){let r=pr(e,`writeBuffer`);if(this.assertNotInFlight(r,`writeBuffer`),n+t.byteLength>r.size)throw new V(`invalid-usage`,`writeBuffer 越界:缓冲「${r.label}」大小 ${r.size},写 [${n}, ${n+t.byteLength})`);r.handle.write(t,n)}writeTexture(e,t,n={}){let r=mr(e,`writeTexture`);this.assertNotInFlight(r,`writeTexture`),fr(r.usage,B.COPY_DST,`纹理「${r.label}」写入`,`COPY_DST`),r.handle.writeData(t,{x:n.x??0,y:n.y??0,width:n.width??r.width,height:n.height??r.height})}uploadImage(e,t,n={}){let r=mr(e,`uploadImage`);if(n.flipY)throw vr(r.label);this.assertNotInFlight(r,`uploadImage`),fr(r.usage,B.COPY_DST,`纹理「${r.label}」上传图像`,`COPY_DST`),r.handle.copyExternalImage({image:t,premultipliedAlpha:n.premultiplyAlpha??!1})}generateMipmaps(e){let t=mr(e,`generateMipmaps`);if(this.assertNotInFlight(t,`generateMipmaps`),fr(t.usage,B.SAMPLED,`纹理「${t.label}」生成 mip`,`SAMPLED`),fr(t.usage,B.RENDER_TARGET,`纹理「${t.label}」生成 mip`,`RENDER_TARGET`),!(t.mipLevels<=1))try{let e=this.luma.getTextureFormatCapabilities(t.handle.format);if(!e.render||!e.filter)throw Error(`格式 ${t.handle.format} 不可渲染或不可过滤(render=${e.render}, filter=${e.filter})`);this.mipmaps??=new An(this.luma.handle),this.mipmaps.generate(t.handle.handle)}catch(e){this.report(new V(`backend`,`纹理「${t.label}」生成 mip 失败:${e instanceof Error?e.message:String(e)}`),`error`)}}async readBuffer(e,t=0,n){let r=pr(e,`readBuffer`);fr(r.usage,z.COPY_SRC,`回读缓冲「${r.label}」`,`COPY_SRC`);let i=n??r.size-t;return this.untilLost(r.handle.readAsync(t,i),`回读缓冲「${r.label}」`)}async readTexture(e){let t=mr(e,`readTexture`);return fr(t.usage,B.COPY_SRC,`回读纹理「${t.label}」`,`COPY_SRC`),this.untilLost(this.readTextureNow(t),`回读纹理「${t.label}」`)}async readTextureNow(e){let t=e.handle.computeMemoryLayout({}),n=this.luma.createBuffer({id:`readback:${e.label}`,usage:a.COPY_DST|a.MAP_READ,byteLength:t.byteLength});try{e.handle.readBuffer({},n);let r=await n.readAsync(0,t.byteLength);return{width:e.width,height:e.height,format:e.format,data:On(r,e.width,e.height,t.bytesPerPixel,t.bytesPerRow)}}finally{n.destroy()}}resizeSwapchain(e,t){this._destroyed||!(e>0&&t>0)||(this.swapchainSize=[e,t],!this.canvasReleased&&this.luma.getDefaultCanvasContext().setDrawingBufferSize(e,t))}runFrame(e){if(this._isLost||this._destroyed)return!1;let t=or(this.frameIndex),n=null;this.releases.beginRecording();try{this.swapchain._beginFrame();for(let e of this.swapchainDepth.values())e._beginFrame();for(let e of this.swapchainMsaa.values())e._beginFrame();n=new rr(this,`帧 ${this.frameIndex}`,t),this.recordings.push(n);let r=e=>{let t=this.swapchainDepth.get(e);return t||(t=new Xn(this.rootScope,this.releases,this.luma,this.luma.getDefaultCanvasContext(),this.caps.swapchainFormat,e),this.swapchainDepth.set(e,t),t._beginFrame()),t};return e({index:this.frameIndex,commands:n,swapchain:this.swapchain,swapchainWithDepth:r,swapchainMultisampled:(e,t=null)=>{if(e===1)return t?r(t):this.swapchain;if(e!==4)throw new V(`unsupported`,`画布多重采样数 ${e} 不支持(WebGPU 只有 1 / 4)`);let n=`${e}|${t??``}`,i=this.swapchainMsaa.get(n);if(!i){let r=this.swapchainMsaaColors.get(e);r||(r=new Zn(this.luma,`画布后备缓冲 MSAA×${e} 颜色`,this.caps.swapchainFormat,e),this.swapchainMsaaColors.set(e,r)),i=new Qn(this.rootScope,this.releases,this.luma,this.luma.getDefaultCanvasContext(),this.caps.swapchainFormat,r,t),this.swapchainMsaa.set(n,i),i._beginFrame()}return i}}),n._submit(),!0}catch(e){return n?._abandon(),this.report(e,`error`),!1}finally{n&&this.recordings.splice(this.recordings.indexOf(n),1),this.swapchain._endFrame();for(let e of this.swapchainDepth.values())e._endFrame();for(let e of this.swapchainMsaa.values())e._endFrame();this._lastFrameStats=t,this.frameIndex++,this.releases.endRecording()}}submit(e,t){if(this._isLost||this._destroyed)return!1;let n=or(this.frameIndex),r=null;this.releases.beginRecording();try{return r=new rr(this,e,n),this.recordings.push(r),t(r),r._submit(),!0}catch(e){return r?._abandon(),this.report(e,`error`),!1}finally{r&&this.recordings.splice(this.recordings.indexOf(r),1),this.releases.endRecording()}}onDiagnostic(e){return this.listeners.add(e),()=>this.listeners.delete(e)}destroy(){this._destroyed||(this._destroyed=!0,this.rootScope.destroy(),this.releaseSwapchainTargets(),this.releases.flush(),this.releaseCanvas(),this.listeners.clear(),this.restoredListeners.clear(),this.luma.destroy())}watchLoss(e){this._lost=e.lost.then(t=>{let n=t?.message||t?.reason||`未知原因`;return e!==this._luma||(this._isLost=!0,this.rejectPendingReadbacks(n),this._destroyed)?n:(this.report(new V(`backend`,`图形设备丢失:${n}`),`error`),this.restore(),n)})}async restore(){let e=this.recovery.recreateDevice;if(!(!e||this.restoring)){this.restoring=!0;try{this.releaseCanvas();let t=this.recovery.restoreRetryDelaysMs??Rn,n=null;for(let r=0;r<t.length;r++){if(t[r]>0&&await new Promise(e=>setTimeout(e,t[r])),this._destroyed)return;let i;try{i=await e()}catch(e){n=e,this.report(new V(`backend`,`图形设备重建失败(第 ${r+1}/${t.length} 次):${Bn(e)}`),`warning`);continue}if(this._destroyed){try{i.getDefaultCanvasContext().destroy()}catch{}i.destroy();return}this.adopt(i);return}this.report(new V(`backend`,`图形设备恢复失败(重建 ${t.length} 次都没成,需要刷新页面):${Bn(n)}`),`error`)}finally{this.restoring=!1}}}adopt(e){let t=this._luma;this.rootScope._invalidateResources(),this.releaseSwapchainTargets(),this.releases.flush();try{t.destroy()}catch(e){this.report(e,`warning`)}this._luma=e,this.canvasReleased=!1,Object.assign(this.caps,zn(e)),Object.assign(this.info,{vendor:e.info.vendor,renderer:e.info.renderer}),this.mipmaps=null;let n=e.getDefaultCanvasContext();this.swapchain=new Xn(this.rootScope,this.releases,e,n,this.caps.swapchainFormat),this.swapchainSize&&n.setDrawingBufferSize(this.swapchainSize[0],this.swapchainSize[1]),this._isLost=!1,this.watchLoss(e),this.report(new V(`backend`,`图形设备已恢复:同一画布上重建了设备,此前的 GPU 资源已作废、按需重建重传(渲染纹理里画过的内容没了)`),`warning`);for(let e of[...this.restoredListeners])try{e()}catch(e){this.report(e,`error`)}}releaseCanvas(){if(!this.canvasReleased){this.canvasReleased=!0;try{this.luma.getDefaultCanvasContext().destroy()}catch(e){this.report(e,`warning`)}}}releaseSwapchainTargets(){for(let e of this.swapchainDepth.values())e.releaseTextures();this.swapchainDepth.clear();for(let e of this.swapchainMsaa.values())e.releaseTextures();this.swapchainMsaa.clear();for(let e of this.swapchainMsaaColors.values())e.release();this.swapchainMsaaColors.clear()}untilLost(e,t){return new Promise((n,r)=>{let i=e=>r(new V(`backend`,`${t}:等待期间图形设备丢失(${e})`));this.pendingReadbacks.add(i),e.then(n,r).finally(()=>this.pendingReadbacks.delete(i))})}rejectPendingReadbacks(e){let t=[...this.pendingReadbacks];this.pendingReadbacks.clear();for(let n of t)n(e)}_createBindGroups(e,t){let n=c(this.luma).getBindGroups(e,t),r=[];for(let e of Object.keys(n))r[Number(e)]=n[Number(e)]??null;for(let e=0;e<r.length;e++)r[e]??=null;return r}_reportBackendError(e){this.report(e instanceof V?e:new V(`backend`,e instanceof Error?e.message:String(e)),`error`)}_warnSkippedDraw(e){this.warnedSkips.has(e)||(this.warnedSkips.add(e),this.report(new V(`backend`,`管线「${e.label}」创建失败,用它的 draw / dispatch 一律跳过(只丢这些 draw,帧里其余内容照常提交)`),`warning`))}captureErrors(e){let t=this.luma.handle;if(!t||typeof t.pushErrorScope!=`function`)return[e(),Promise.resolve(null)];t.pushErrorScope(`validation`),t.pushErrorScope(`internal`);let n,r;try{n=e()}finally{let e=t.popErrorScope().catch(()=>null),n=t.popErrorScope().catch(()=>null);r=Promise.all([e,n]).then(([e,t])=>e??t)}return[n,r]}assertNotInFlight(e,t){let n=this.recordings.find(t=>t._uses(e));if(n)throw new V(`invalid-usage`,`${t}:「${e.label}」已被正在录制的「${n.label}」引用,录制期间不能再写(写入在整批命令执行之前生效,前面录好的命令也会读到新值;请换缓冲 / 偏移,或在录制前写好)`)}resolveStreamSlots(e,t){let n=new Map;for(let r of t.vertexBuffers??[]){let i=e.getBufferSlot(r.name);if(i==null)throw new V(`invalid-usage`,`管线「${t.label}」:顶点流「${r.name}」在着色器里没有对应的属性`);n.set(r.name,i)}return n}report(e,t){let n=e instanceof V?e:new V(`backend`,e instanceof Error?e.message:String(e));if(this.listeners.size===0){t===`error`?console.error(n):console.warn(n);return}for(let e of this.listeners)try{e(n,t)}catch(e){console.error(`RHI 诊断监听器自身抛错`,e)}}};function cr(e,t){let{resolvedBufferSlots:n,logicalBufferSlots:r}=e;if(!n||!r)throw new V(`backend`,`管线「${t}」:luma 顶点数组缺 resolvedBufferSlots / logicalBufferSlots(luma 版本变了?)`);let i=[];for(let e of n)i[e.shaderSlot]={logicalSlot:r[e.bufferName]??e.shaderSlot,bindingOffset:e.bindingOffset};return i}function lr(e){let t=0;return e&1&&(t|=B.COPY_SRC),e&2&&(t|=B.COPY_DST),e&4&&(t|=B.SAMPLED),e&8&&(t|=B.STORAGE),e&16&&(t|=B.RENDER_TARGET),t}async function ur(e,t,n,r){for(let t of new Set(n)){let n=t.module;if(await n.asyncCompilationStatus===`error`){let t=(await n.getCompilationInfo().catch(()=>[])).filter(e=>e.type===`error`).map(e=>`${e.lineNum}:${e.linePos} ${e.message}`).join(`
`);throw new V(`backend`,`管线「${e}」:着色器「${n.id}」编译失败\n${t}`)}let r=await t.creationError;if(r)throw new V(`backend`,`管线「${e}」:着色器「${t.label}」创建失败\n${r.message}`)}for(let t of r){let n=await t;if(n)throw new V(`backend`,`管线「${e}」创建 / 校验失败\n${n.message}`)}let i=Date.now();for(let n of t)for(;n._syncLinkStatus?.(),n.linkStatus!==`success`;){if(n.linkStatus===`error`)throw new V(`backend`,`管线「${e}」链接 / 校验失败`);if(Date.now()-i>6e4)throw new V(`backend`,`管线「${e}」等待链接超过 60 秒`);await new Promise(e=>setTimeout(e,4))}}function dr(e,t){return e.length===t.length&&e.every((e,n)=>e===t[n])}function fr(e,t,n,r){if((e&t)===0)throw new V(`invalid-usage`,`${n} 需要用途位 ${r}(创建时没给)`)}function pr(e,t){if(!(e instanceof Vn))throw new V(`invalid-usage`,`${t}:不是本设备的缓冲`);return e.assertAlive(t),e}function mr(e,t){if(!(e instanceof Hn))throw new V(`invalid-usage`,`${t}:不是本设备的纹理`);return e.assertAlive(t),e}function hr(e,t){if(!(e instanceof Wn))throw new V(`invalid-usage`,`${t}:不是本设备的着色器`);return e.assertAlive(t),e}function gr(e,t){if(!(e instanceof qn))throw new V(`invalid-usage`,`${t}:不是本设备的计算管线`);return e.assertAlive(t),e}function _r(e,t=`渲染目标`){if(!(e instanceof Jn)&&!(e instanceof Xn)&&!(e instanceof Qn))throw new V(`invalid-usage`,`${t}:不是本设备的渲染目标`);return e}function vr(e){return new V(`unsupported`,`纹理「${e}」:图像上传不支持 flipY(luma WebGPU 固定不翻转);要翻转请在着色器里翻 uv 或上传前翻好`)}var yr=class{constructor(e){this.type=2,this.name=`webgpu`,this.screen=new E,this.lastObjectRendered=null,this.events=null,this.rhi=e.rhi,this.canvas=e.canvas,this.resolution=e.resolution??1,this.autoDensity=!!e.autoDensity,this.roundPixels=!!e.roundPixels;let t=new ne(e.background??e.backgroundColor??0),n={color:t,alpha:e.backgroundAlpha??1,clearBeforeRender:e.clearBeforeRender??!0,get colorRgba(){return[t.red,t.green,t.blue,n.alpha]}};this.background=n,this.resize(e.width??this.canvas.width/this.resolution,e.height??this.canvas.height/this.resolution,this.resolution)}get width(){return this.screen.width}get height(){return this.screen.height}get view(){return{canvas:this.canvas,resolution:this.resolution,screen:this.screen}}resize(e,t,n){n||=this.resolution,e||=this.screen.width,t||=this.screen.height;let r=Math.round(e*n),i=Math.round(t*n);n!==this.resolution&&this.events?.resolutionChange(n),this.resolution=n,this.screen.width=r/n,this.screen.height=i/n,this.canvas.width!==r&&(this.canvas.width=r),this.canvas.height!==i&&(this.canvas.height=i),this.rhi.resizeSwapchain(r,i),this.autoDensity&&`style`in this.canvas&&(this.canvas.style.width=`${this.screen.width}px`,this.canvas.style.height=`${this.screen.height}px`)}},br={r8unorm:1,rg8unorm:2,rgba8unorm:4,"rgba8unorm-srgb":4,bgra8unorm:4,r16float:2,rg16float:4,rgba16float:8,r32float:4,rg32float:8,rgba32float:16,r32uint:4,rgba32uint:16};function xr(e){if(!(e in br))throw Error(`[engine2d] 纹理格式 ${e} 不支持`);return e}function Sr(e,t){return typeof ImageBitmap<`u`&&e instanceof ImageBitmap?t!==`premultiplied-alpha`:t===`premultiply-alpha-on-upload`}var Cr=class{constructor(e,t,n={get now(){return performance.now()}}){this.rhi=e,this.scope=t,this.clock=n,this.entries=new Map,this.samplers=new Map,this.styleKeys=new WeakMap,this.onRelease=null}get(e,t=!1){if(e.destroyed)throw Error(`[engine2d] 纹理源「${e.label}」已销毁`);let n=this.entries.get(e);if(n&&n.resourceId!==e._resourceId&&(this.drop(e,n),n=void 0),!n){let r=xr(e.format),i=e.resource!=null;e.autoGenerateMipmaps&&(e.mipLevelCount=Math.floor(Math.log2(Math.max(e.pixelWidth,e.pixelHeight)))+1);let a=Math.max(1,e.mipLevelCount|0),o=B.SAMPLED|B.COPY_DST|B.COPY_SRC;(!i||t||e.uploadMethodId===`image`||e.uploadMethodId===`video`||a>1)&&(o|=B.RENDER_TARGET),n={texture:this.scope.createTexture({label:e.label||`engine2d-tex-${e.uid}`,width:Math.max(1,e.pixelWidth),height:Math.max(1,e.pixelHeight),format:r,usage:o,...a>1?{mipLevels:a}:{}}),resourceId:e._resourceId,updateId:-1,format:r,lastUsed:this.clock.now},this.entries.set(e,n),e.once(`destroy`,this.onSourceGone,this),e.once(`unload`,this.onSourceGone,this),e.on(`updateMipmaps`,this.onUpdateMipmaps,this)}else if(t&&!(n.texture.usage&B.RENDER_TARGET))return this.drop(e,n),this.get(e,!0);return n.lastUsed=this.clock.now,n.updateId!==e._updateId&&(n.updateId=e._updateId,this.upload(e,n.texture)&&e.autoGenerateMipmaps&&n.texture.mipLevels>1&&this.rhi.generateMipmaps(n.texture)),n.texture}has(e){return this.entries.has(e)}sampler(e){let t=this.styleKeys.get(e);if(!t||t.updateId!==e._updateId){let{key:n,fields:r}=e._captureKey();t={updateId:e._updateId,key:n,fields:r},this.styleKeys.set(e,t)}let n=t.key,r=this.samplers.get(n);if(!r){let e=t.fields;r=this.scope.createSampler({label:`engine2d-sampler ${n}`,addressModeU:e.addressModeU,addressModeV:e.addressModeV,addressModeW:e.addressModeW,magFilter:e.magFilter,minFilter:e.minFilter,mipmapFilter:e.mipmapFilter,lodMinClamp:e.lodMinClamp,lodMaxClamp:e.lodMaxClamp,maxAnisotropy:e.maxAnisotropy,compare:e.compare}),this.samplers.set(n,r)}return r}release(e){let t=this.entries.get(e);t&&this.drop(e,t)}collect(e,t){for(let[n,r]of[...this.entries])n.autoGarbageCollect&&e-r.lastUsed>=t&&n.unload()}destroy(){this.reset()}reset(){for(let[e,t]of[...this.entries])this.unhook(e),t.texture.destroy();this.entries.clear();for(let e of this.samplers.values())e.destroy();this.samplers.clear(),this.styleKeys=new WeakMap}onSourceGone(e){this.styleKeys.delete(e.style),this.release(e)}onUpdateMipmaps(e){let t=this.entries.get(e);t&&t.texture.mipLevels>1&&this.rhi.generateMipmaps(t.texture)}drop(e,t){this.onRelease?.(t.texture),t.texture.destroy(),this.entries.delete(e),this.unhook(e)}unhook(e){e.off(`destroy`,this.onSourceGone,this),e.off(`unload`,this.onSourceGone,this),e.off(`updateMipmaps`,this.onUpdateMipmaps,this)}upload(e,t){let n=e.resource;if(n==null)return!1;if(ArrayBuffer.isView(n)){let r=br[e.format]??4,i=e.pixelWidth*e.pixelHeight*r,a=n,o=a.byteLength>i?new Uint8Array(a.buffer,a.byteOffset,i):a;return this.rhi.writeTexture(t,o),!0}return!e.resourceWidth||!e.resourceHeight?!1:(this.rhi.uploadImage(t,n,{premultiplyAlpha:Sr(n,e.alphaMode)}),!0)}};function wr(e){let t=z.COPY_DST;return e&R.VERTEX&&(t|=z.VERTEX),e&R.INDEX&&(t|=z.INDEX),e&R.UNIFORM&&(t|=z.UNIFORM),e&R.STORAGE&&(t|=z.STORAGE),t}var Tr=class{constructor(e,t,n={get now(){return performance.now()}}){this.rhi=e,this.scope=t,this.clock=n,this.entries=new Map}get(e){let t=e.usage&R.INDEX?e.data instanceof Uint16Array?`uint16`:`uint32`:void 0,n=this.entries.get(e);n&&n.resourceId!==e._resourceId&&(this.drop(e,n),n=void 0);let r=e.data,i=!1;if(!n){let a=Math.max(4,Math.ceil(r.byteLength/4)*4);n={buffer:this.scope.createBuffer({label:e.label??`engine2d-buffer-${e.uid}`,usage:wr(e.usage),size:a,indexFormat:t}),resourceId:e._resourceId,updateId:-1,lastUsed:this.clock.now},this.entries.set(e,n),e.once(`destroy`,this.onBufferGone,this),e.once(`unload`,this.onBufferGone,this),i=!0}if(n.lastUsed=this.clock.now,n.updateId!==e._updateID){n.updateId=e._updateID;let t=Math.min(Math.ceil((i?r.byteLength:e._uploadSize)/4)*4,n.buffer.size);if(t>0)if(r.byteLength%4==0||t<=r.byteLength){let e=Math.min(t,Math.floor(r.byteLength/4)*4);e>0&&this.rhi.writeBuffer(n.buffer,new Uint8Array(r.buffer,r.byteOffset,e)),e<t&&this.writeTail(n.buffer,r,e)}else this.writeTail(n.buffer,r,0)}return n.buffer}writeTail(e,t,n){let r=t.byteLength-n,i=new Uint8Array(Math.ceil(r/4)*4);i.set(new Uint8Array(t.buffer,t.byteOffset+n,r)),this.rhi.writeBuffer(e,i,n)}release(e){let t=this.entries.get(e);t&&this.drop(e,t)}collect(e,t){for(let[n,r]of[...this.entries])n.autoGarbageCollect&&e-r.lastUsed>=t&&n.unload()}destroy(){this.reset()}reset(){for(let[e,t]of[...this.entries])this.unhook(e),t.buffer.destroy();this.entries.clear()}onBufferGone(e){this.release(e)}drop(e,t){t.buffer.destroy(),this.entries.delete(e),this.unhook(e)}unhook(e){e.off(`destroy`,this.onBufferGone,this),e.off(`unload`,this.onBufferGone,this)}},Er=!0,Dr=3600,Or=class e{static{this.defaultOptions={gcActive:!0,gcMaxUnusedTime:6e4,gcFrequency:3e4}}constructor(t={}){this.collectors=[],this._enabled=!1,this.last=0;let n={...e.defaultOptions,...kr(t)};this.maxUnusedTime=n.gcMaxUnusedTime,this.frequency=n.gcFrequency,this.now=performance.now(),this.enabled=n.gcActive,t.textureGCActive!==void 0&&t.textureGCActive!==Er&&(this.enabled=t.textureGCActive),t.textureGCMaxIdle!==void 0&&t.textureGCMaxIdle!==Dr&&(this.maxUnusedTime=t.textureGCMaxIdle/60*1e3)}get enabled(){return this._enabled}set enabled(e){this._enabled!==e&&(this._enabled=e,e&&(this.last=performance.now()))}addCollector(e){this.collectors.push(e)}prerender(){this.now=performance.now()}postrender(){if(!this._enabled)return;let e=performance.now();e-this.last<this.frequency||(this.last=e,this.run())}run(){let e=performance.now();for(let t of this.collectors)t(e,this.maxUnusedTime)}destroy(){this._enabled=!1,this.collectors.length=0}};function kr(e){let t={};for(let n of[`gcActive`,`gcMaxUnusedTime`,`gcFrequency`])e[n]!==void 0&&(t[n]=e[n]);return t}var H=(e,t,n=`add`)=>({srcFactor:e,dstFactor:t,operation:n}),Ar={normal:{color:H(`one`,`one-minus-src-alpha`),alpha:H(`one`,`one-minus-src-alpha`)},add:{color:H(`one`,`one`),alpha:H(`one`,`one`)},multiply:{color:H(`dst`,`one-minus-src-alpha`),alpha:H(`one`,`one-minus-src-alpha`)},screen:{color:H(`one`,`one-minus-src`),alpha:H(`one`,`one-minus-src-alpha`)},none:null,"normal-npm":{color:H(`src-alpha`,`one-minus-src-alpha`),alpha:H(`one`,`one-minus-src-alpha`)},"add-npm":{color:H(`src-alpha`,`one`),alpha:H(`one`,`one`)},"screen-npm":{color:H(`src-alpha`,`one-minus-src`),alpha:H(`one`,`one-minus-src-alpha`)},erase:{color:H(`zero`,`one-minus-src-alpha`),alpha:H(`zero`,`one-minus-src-alpha`)},min:{color:H(`one`,`one`,`min`),alpha:H(`one`,`one`,`min`)},max:{color:H(`one`,`one`,`max`),alpha:H(`one`,`one`,`max`)}},jr=`depth24plus-stencil8`,Mr={disabled:{compare:`always`,passOp:`keep`,writeMask:0,readMask:0},add:{compare:`equal`,passOp:`increment-clamp`},remove:{compare:`equal`,passOp:`decrement-clamp`},active:{compare:`equal`,passOp:`keep`,writeMask:0},inverse:{compare:`not-equal`,passOp:`keep`,writeMask:0}},Nr=/^(r|rg|rgba)8unorm$|^rgba8unorm-srgb$|^bgra8unorm$|^(r|rg|rgba)16float$/;function Pr(e,t){return e&&Nr.test(t)?4:1}var Fr=/^(r|rg|rgba)32float$|int$/,Ir={disabled:0,add:1,remove:2,active:3,inverse:4},Lr=1024,Rr=class{constructor(e){this.scope=e,this.shaders=new Map,this.pipelines=new Map,this.fast=new WeakMap,this.stateIds=new Map,this.layouts=new WeakMap,this.ensuredGeometries=new WeakSet,this.waits=new Set,this.destroyed=!1}shader(e){let t=this.shaders.get(e.uid);return t||(t=this.scope.createShader({label:e.name??`engine2d-program-${e.uid}`,wgsl:e.source,entryPoints:{vertex:e.vertexEntry,fragment:e.fragmentEntry}}),this.shaders.set(e.uid,t)),t}get(e){let t=this.fast.get(e.program);t||this.fast.set(e.program,t=new WeakMap);let n=t.get(e.layout);n||t.set(e.layout,n=new Map);let r=this.stateKey(e);if(r>=0){let e=n.get(r);if(e)return e}let i=this.getSlow(e);return r>=0&&n.set(r,i),i}stateKey(e){let t=this.stateId(e.topology),n=this.stateId(e.blend),r=this.stateId(e.colorFormat),i=e.depthFormat?this.stateId(e.depthFormat)+1:0;if(t>=Lr||n>=Lr||r>=Lr||i>=Lr||!(e.colorMask>=0&&e.colorMask<16)||!(e.sampleCount>=1&&e.sampleCount<32))return-1;let a=e.depthFormat?Ir[e.stencil]:0;return(((((t*Lr+n)*Lr+r)*Lr+i)*8+a)*16+e.colorMask)*32+e.sampleCount}stateId(e){let t=this.stateIds.get(e);return t===void 0&&this.stateIds.set(e,t=this.stateIds.size),t}getSlow(e){let t=`${e.program.uid}|${e.layout.key}|${e.topology}|${e.blend}|${e.colorFormat}|${e.depthFormat}|${e.depthFormat?e.stencil:`-`}|${e.colorMask}|${e.sampleCount}`,n=this.pipelines.get(t);if(!n){let r=Ar[e.blend===`inherit`?`normal`:e.blend]??null;Fr.test(e.colorFormat)&&(r=null),n=this.scope.createRenderPipeline({label:`${e.program.name??`program-${e.program.uid}`} → ${e.colorFormat}${e.sampleCount>1?`×${e.sampleCount}`:``}${e.depthFormat?`+${e.stencil}`:``} ${e.blend}`,shader:this.shader(e.program),vertexBuffers:e.layout.buffers,topology:e.topology,colorFormats:[e.colorFormat],depthFormat:e.depthFormat??void 0,depth:e.depthFormat?{write:!1,compare:`always`}:void 0,stencil:e.depthFormat?Mr[e.stencil]:void 0,blend:r,colorWriteMask:e.colorMask,cullMode:`none`,sampleCount:e.sampleCount}),this.pipelines.set(t,n)}return n}async whenAllReady(e){if(this.destroyed)return!1;let t=Promise.allSettled([...this.pipelines.values()].map(e=>e.ready)).then(()=>!0),n,r,i=new Promise(t=>{r=t,n=setTimeout(()=>t(!1),Math.max(0,e))});this.waits.add(r);try{return await Promise.race([t,i])}finally{clearTimeout(n),this.waits.delete(r)}}layout(e,t){let n=this.layouts.get(e);n||this.layouts.set(e,n=new Map),this.ensuredGeometries.has(e)||(bt(e,t.attributes),this.ensuredGeometries.add(e));let r=e._attributesVersion,i=n.get(t.uid);if(i&&i.version===r)return i.layout;let a=new Set(t.attributes.map(e=>e.name)),o=new Map;for(let[t,n]of Object.entries(e.attributes)){if(!a.has(t))continue;let e=o.get(n.buffer);e||o.set(n.buffer,e=[]),e.push({name:t,format:n.format,offset:n.offset??0,stride:n.stride,instance:!!n.instance})}let s=[],c=[],l=0;for(let e of o.values()){let t=e.find(e=>e.stride)?.stride??(e.length===1?xt(e[0].format):e.reduce((e,t)=>e+xt(t.format),0));s.push({name:`stream${l++}`,stride:t,stepMode:e[0].instance?`instance`:`vertex`,attributes:e.map(e=>({name:e.name,format:e.format,offset:e.offset}))}),c.push(e[0].name)}let u={key:s.map(e=>`${e.stride}:${e.stepMode}:${e.attributes.map(e=>`${e.name}/${e.format}/${e.offset}`).join(`,`)}`).join(`;`),buffers:s,sources:c};return n.set(t.uid,{version:r,layout:u}),u}destroy(){this.destroyed=!0;for(let e of[...this.waits])e(!1);this.waits.clear(),this.reset()}reset(){for(let e of this.pipelines.values())e.destroy();for(let e of this.shaders.values())e.destroy();this.pipelines.clear(),this.shaders.clear(),this.fast=new WeakMap}},zr={normal:`normal-npm`,add:`add-npm`,screen:`screen-npm`},Br=`
fn roundPixels(position: vec2<f32>, targetSize: vec2<f32>) -> vec2<f32> {
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

fn roundPixelsTarget(position: vec2<f32>) -> vec2<f32> {
  var p = position;
  if (globalUniforms.uRoundFlipY > 0.5) { p.y = -p.y; }
  p = roundPixels(p, globalUniforms.uResolution);
  if (globalUniforms.uRoundFlipY > 0.5) { p.y = -p.y; }
  return p;
}
`;function Vr(e){let t=``;for(let n=1;n<=e;n++)t+=`@group(1) @binding(${(n-1)*2}) var textureSource${n}: texture_2d<f32>;\n`,t+=`@group(1) @binding(${(n-1)*2+1}) var textureSampler${n}: sampler;\n`;return t}function Hr(e){let t=`switch vTextureId {
`;for(let n=0;n<e-1;n++)t+=`  case ${n}: { outColor = textureSampleGrad(textureSource${n+1}, textureSampler${n+1}, vUV, uvDx, uvDy); }\n`;return t+=`  default: { outColor = textureSampleGrad(textureSource${e}, textureSampler${e}, vUV, uvDx, uvDy); }\n}`,t}function Ur(e){return`
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
  uRoundFlipY: f32,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
${Vr(16)}${e?`
struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(2) @binding(0) var<uniform> localUniforms: LocalUniforms;
`:``}
${Br}
struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) @interpolate(flat) vTextureId: u32,
  @location(1) vColor: vec4<f32>,
  @location(2) vUV: vec2<f32>,
};

@vertex
fn mainVertex(
  @location(0) aColor: vec4<f32>,
  @location(1) aPosition: vec2<f32>,
  @location(2) aTextureIdAndRound: vec2<u32>,
  @location(3) aUV: vec2<f32>,
) -> VSOutput {
  var worldTransformMatrix = globalUniforms.uWorldTransformMatrix;
  var modelMatrix = mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  var position = aPosition;
  var uv = aUV;
  var vColor = vec4<f32>(1., 1., 1., 1.);
  vColor *= vec4<f32>(aColor.rgb * aColor.a, aColor.a);
  let vTextureId = aTextureIdAndRound.y;${e?`
  vColor *= localUniforms.uColor;
  modelMatrix *= localUniforms.uTransformMatrix;`:``}
  let vUV = uv;
  var modelViewProjectionMatrix = globalUniforms.uProjectionMatrix * worldTransformMatrix * modelMatrix;
  var vPosition = vec4<f32>((modelViewProjectionMatrix * vec3<f32>(position, 1.0)).xy, 0.0, 1.0);
  vColor *= globalUniforms.uWorldColorAlpha;
  if (aTextureIdAndRound.x == 1u) {
    vPosition = vec4<f32>(roundPixelsTarget(vPosition.xy), vPosition.zw);
  }${e?`
  if (localUniforms.uRound == 1.0) {
    vPosition = vec4(roundPixelsTarget(vPosition.xy), vPosition.zw);
  }`:``}
  return VSOutput(vPosition, vTextureId, vColor, vUV);
}

@fragment
fn mainFragment(
  @location(0) @interpolate(flat) vTextureId: u32,
  @location(1) vColor: vec4<f32>,
  @location(2) vUV: vec2<f32>,
) -> @location(0) vec4<f32> {
  var uvDx = dpdx(vUV);
  var uvDy = dpdy(vUV);
  var outColor: vec4<f32>;
  ${Hr(16)}
  return outColor * vColor;
}
`}var Wr=Ur(!1),Gr=Ur(!0),Kr=`
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
  uRoundFlipY: f32,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct TextureUniforms {
  uTextureMatrix: mat3x3<f32>,
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var<uniform> textureUniforms: TextureUniforms;

${Br}
struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) vColor: vec4<f32>,
  @location(1) vUV: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
  var worldTransformMatrix = globalUniforms.uWorldTransformMatrix;
  var modelMatrix = mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  var vColor = vec4<f32>(1., 1., 1., 1.);
  vColor *= localUniforms.uColor;
  modelMatrix *= localUniforms.uTransformMatrix;
  let uv = (textureUniforms.uTextureMatrix * vec3(aUV, 1.0)).xy;
  var modelViewProjectionMatrix = globalUniforms.uProjectionMatrix * worldTransformMatrix * modelMatrix;
  var vPosition = vec4<f32>((modelViewProjectionMatrix * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  vColor *= globalUniforms.uWorldColorAlpha;
  if (localUniforms.uRound == 1.0) {
    vPosition = vec4(roundPixelsTarget(vPosition.xy), vPosition.zw);
  }
  return VSOutput(vPosition, vColor, uv);
}

@fragment
fn mainFragment(@location(0) vColor: vec4<f32>, @location(1) vUV: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, vUV) * vColor;
}
`;function qr(e,t){return t.alphaMode===`no-premultiply-alpha`?zr[e]??e:e}var Jr=class{constructor(){this.attr=new ArrayBuffer(4*1024*4),this.f32=new Float32Array(this.attr),this.u32=new Uint32Array(this.attr),this.indices=new Uint32Array(6*1024),this.attributeSize=0,this.indexSize=0,this.pending=[],this.pendingAttr=[],this.pendingIndex=[],this.batchIndexStart=0,this.batchIndexSize=0}begin(){this.attributeSize=0,this.indexSize=0,this.pending.length=0,this.pendingAttr.length=0,this.pendingIndex.length=0,this.batchIndexStart=0,this.batchIndexSize=0}add(e){this.pending.push(e),this.pendingIndex.push(this.indexSize),this.pendingAttr.push(this.attributeSize),this.indexSize+=e.indexSize,this.attributeSize+=e.attributeSize*6}break(e){let t=this.pending;if(t.length===0)return;this.ensure(this.attributeSize,this.indexSize);let n=this.f32,r=this.u32,i=this.indices,a=t[0],o=qr(a.blendMode,a.texture.source),s=a.topology,c=this.batchIndexSize,l=this.batchIndexStart,u=[],d=new Map,f=0,p=0,m=()=>{e.push({t:`batch`,textures:u,blendMode:o,topology:s,start:l,size:c-l});for(let e=f;e<p;e++)t[e].onBatchTextures?.(u);f=p};for(let e=0;e<t.length;e++){p=e;let a=t[e],f=a.texture.source,h=qr(a.blendMode,f),g=o!==h||s!==a.topology,_=d.get(f);(_===void 0||g)&&((u.length>=16||g)&&(m(),l=c,o=h,s=a.topology,u=[],d=new Map),_=u.length,d.set(f,_),u.push(f)),c+=a.indexSize;let v=this.pendingAttr[e];a.packAsQuad?(Xr(a,n,r,v,_),Zr(i,this.pendingIndex[e],v/6)):(Yr(a,n,r,v,_),Qr(a,i,this.pendingIndex[e],v/6))}u.length>0&&(p=t.length,m(),l=c),this.batchIndexStart=l,this.batchIndexSize=c,this.pending.length=0,this.pendingAttr.length=0,this.pendingIndex.length=0}ensure(e,t){if(e*4>this.attr.byteLength){let t=this.attr.byteLength;for(;t<e*4;)t*=2;let n=new ArrayBuffer(t);new Uint8Array(n).set(new Uint8Array(this.attr)),this.attr=n,this.f32=new Float32Array(n),this.u32=new Uint32Array(n)}if(t>this.indices.length){let e=this.indices.length;for(;e<t;)e*=2;let n=new Uint32Array(e);n.set(this.indices),this.indices=n}}};function Yr(e,t,n,r,i){let a=i<<16|e.roundPixels&65535,{a:o,b:s,c,d:l,tx:u,ty:d}=e.transform,f=e.positions,p=e.uvs,m=e.color,h=e.attributeOffset,g=h+e.attributeSize;for(let e=h;e<g;e++){let i=e*2,h=f[i],g=f[i+1];t[r++]=o*h+c*g+u,t[r++]=l*g+s*h+d,t[r++]=p[i],t[r++]=p[i+1],n[r++]=m,n[r++]=a}}function Xr(e,t,n,r,i){let a=e.texture.uvs,{a:o,b:s,c,d:l,tx:u,ty:d}=e.transform,f=e.bounds,p=f.maxX,m=f.minX,h=f.maxY,g=f.minY,_=e.color,v=i<<16|e.roundPixels&65535;t[r+0]=o*m+c*g+u,t[r+1]=l*g+s*m+d,t[r+2]=a.x0,t[r+3]=a.y0,n[r+4]=_,n[r+5]=v,t[r+6]=o*p+c*g+u,t[r+7]=l*g+s*p+d,t[r+8]=a.x1,t[r+9]=a.y1,n[r+10]=_,n[r+11]=v,t[r+12]=o*p+c*h+u,t[r+13]=l*h+s*p+d,t[r+14]=a.x2,t[r+15]=a.y2,n[r+16]=_,n[r+17]=v,t[r+18]=o*m+c*h+u,t[r+19]=l*h+s*m+d,t[r+20]=a.x3,t[r+21]=a.y3,n[r+22]=_,n[r+23]=v}function Zr(e,t,n){e[t]=n+0,e[t+1]=n+1,e[t+2]=n+2,e[t+3]=n+0,e[t+4]=n+2,e[t+5]=n+3}function Qr(e,t,n,r){let i=e.indices,a=e.indexSize,o=e.indexOffset,s=e.attributeOffset;for(let e=0;e<a;e++)t[n++]=r+i[e+o]-s}var $r=0;function ei(e){return e<0?0:e>1?1:e}function ti(e,t){if(!e._activeSelf)return;let n=e.onRender;n&&n.call(e,t);let r=e.children;for(let e=0;e<r.length;e++)ti(r[e],t)}function ni(e,t){e._validateRenderGroup(t);for(let n of e.children)ni(n,t)}function ri(e,t,n,r){e.enableRenderGroup(),ti(e,t);let i=typeof t==`object`&&t?t:void 0;ni(e,i),$r=t?.roundPixels?1:0,e.updateLocalTransform(),e._renderedGroupWorldTransform.copyFrom(r??e.localTransform),e.groupTransform.identity(),e.groupColor=16777215,e.groupAlpha=1,e.groupColorAlpha=4294967295,e.groupBlendMode=`normal`,e.globalDisplayStatus=e.localDisplayStatus,e._renderTick=n,e._prepareRenderGroup(i,e.globalDisplayStatus===7);let a=e.children;for(let t=0;t<a.length;t++)ai(a[t],null,n,e,i)}function ii(e,t,n){let r=e._renderedRelativeTransform??=new S;return t&&t!==n?r.appendFrom(e.localTransform,t._renderedRelativeTransform):r.copyFrom(e.localTransform),e._renderedGroupWorldTransform?(e._renderedGroupWorldTransform.appendFrom(r,n._renderedGroupWorldTransform),e):n}function ai(e,t,n,r,i){if(!e._activeSelf){e.globalDisplayStatus=0,e._renderTick=n,oi(e,t,r,i);return}e.updateLocalTransform();let a=r&&ii(e,t,r);t?(e.groupTransform.appendFrom(e.localTransform,t.groupTransform),e.groupColor=Qe(e.localColor,t.groupColor),e.groupAlpha=ei(e.localAlpha*t.groupAlpha),e.groupBlendMode=e.localBlendMode===`inherit`?t.groupBlendMode:e.localBlendMode,e.globalDisplayStatus=e.localDisplayStatus&t.globalDisplayStatus):(e.groupTransform.copyFrom(e.localTransform),e.groupColor=e.localColor,e.groupAlpha=ei(e.localAlpha),e.groupBlendMode=e.localBlendMode===`inherit`?`normal`:e.localBlendMode,e.globalDisplayStatus=e.localDisplayStatus),e.groupColorAlpha=e.groupColor+((e.groupAlpha*255|0)<<24),e._renderTick=n,r&&e.isRenderGroup&&e._prepareRenderGroup(i,e.globalDisplayStatus===7);let o=e.children;for(let t=0;t<o.length;t++)ai(o[t],e,n,a,i)}function oi(e,t,n,r){e.updateLocalTransform();let i=n&&ii(e,t,n);t?e.groupTransform.appendFrom(e.localTransform,t.groupTransform):e.groupTransform.copyFrom(e.localTransform),n&&e.isRenderGroup&&e._prepareRenderGroup(r,!1);let a=e.children;for(let t=0;t<a.length;t++)oi(a[t],e,i,r)}function si(e,t,n){if(e._renderTick===n)return;let r=[],i=e;for(;i&&i!==t;)r.push(i),i=i.parent;if(i===t){r.reverse();let e=null;for(let t of r)t._renderTick!==n&&ci(t,e),e=t}else{let n=new S,r=t.worldTransform.clone().invert();n.appendFrom(e.worldTransform,r),e.updateLocalTransform(),e.groupTransform.copyFrom(n),e.groupColor=Xe(e.getGlobalTint()),e.groupAlpha=ei(e.getGlobalAlpha()),e.groupBlendMode=e.localBlendMode===`inherit`?`normal`:e.localBlendMode,e.globalDisplayStatus=e.localDisplayStatus,e.groupColorAlpha=e.groupColor+((e.groupAlpha*255|0)<<24)}e._renderTick=n;let a=e.children;for(let t=0;t<a.length;t++)ai(a[t],e,n)}function ci(e,t){e.updateLocalTransform(),t?(e.groupTransform.appendFrom(e.localTransform,t.groupTransform),e.groupColor=Qe(e.localColor,t.groupColor),e.groupAlpha=ei(e.localAlpha*t.groupAlpha),e.groupBlendMode=e.localBlendMode===`inherit`?t.groupBlendMode:e.localBlendMode,e.globalDisplayStatus=e.localDisplayStatus&t.globalDisplayStatus):(e.groupTransform.copyFrom(e.localTransform),e.groupColor=e.localColor,e.groupAlpha=ei(e.localAlpha),e.groupBlendMode=e.localBlendMode===`inherit`?`normal`:e.localBlendMode,e.globalDisplayStatus=e.localDisplayStatus),e.groupColorAlpha=e.groupColor+((e.groupAlpha*255|0)<<24)}var li=class{constructor(e,t,n=e){this.batcher=e,this.resolution=t,this.rendererKey=n,this.instructions=[],this.roundPixels=0,this.batches=[],this.maskRanges=new Map,this.colorStack=[15],this.colorStackIndex=1,this.currentColor=15,this.tick=0}begin(e,t,n,r=$r){this.instructions.length=0,this.roundPixels=r,this.maskRanges.clear(),this.colorStack[0]=15,this.colorStackIndex=1,this.currentColor=15,this.batcher.begin(),this.root=e,this.tick=t,this.resolution=n}collectRoot(e){e.sortableChildren&&e.sortChildren(),this.collectWithEffects(e),this.flush()}collect(e){e.globalDisplayStatus<7||!e.includeInBuild||(e.sortableChildren&&e.sortChildren(),e.isRenderGroup&&this.flush(),this.collectWithEffects(e),e.isRenderGroup&&this.flush())}collectWithEffects(e){let t=e.effects;for(let n=0;n<t.length;n++){let r=t[n];r.kind===`mask`?this.pushMask(e,r):this.pushFilter(e,r)}e.collectRenderables(this);let n=e.children;for(let e=0;e<n.length;e++)this.collect(n[e]);for(let n=t.length-1;n>=0;n--){let r=t[n];r.kind===`mask`?this.popMask(e,r):this.popFilter()}}addBatchable(e){this.batcher.add(e)}addCustom(e){this.flush(),this.instructions.push({t:`custom`,drawable:e})}addUnbatched(e,t){this.flush();for(let e of t)this.batcher.add(e);let n=[];this.batcher.break(n),n.length&&this.instructions.push({t:`unbatched`,item:e,batches:n})}pushFilter(e,t){this.flush(),this.instructions.push({t:`pushFilter`,container:e,effect:t})}popFilter(){this.flush(),this.instructions.push({t:`popFilter`})}pushMask(e,t){t.pipe===`alphaMask`?this.pushAlphaMask(e,t):t.pipe===`colorMask`?this.pushColorMask(t):this.pushStencilMask(e,t)}popMask(e,t){t.pipe===`alphaMask`?this.popAlphaMask(t):t.pipe===`colorMask`?this.popColorMask():this.popStencilMask(e,t)}pushAlphaMask(e,t){this.flush();let n=!!e._maskOptions.inverse;this.instructions.push({t:`pushAlphaMaskBegin`,mask:t,container:e,inverse:n}),t.inverse=n;let r=t.mask;si(r,this.root,this.tick),t.renderMaskToTexture&&(r.includeInBuild=!0,this.collect(r),r.includeInBuild=!1),this.flush(),this.instructions.push({t:`pushAlphaMaskEnd`,mask:t,container:e,inverse:n})}popAlphaMask(e){this.flush(),this.instructions.push({t:`popAlphaMaskEnd`,mask:e})}pushColorMask(e){this.flush();let t=this.colorStack;t[this.colorStackIndex]=t[this.colorStackIndex-1]&e.mask;let n=t[this.colorStackIndex];n!==this.currentColor&&(this.currentColor=n,this.instructions.push({t:`colorMask`,colorMask:n})),this.colorStackIndex++}popColorMask(){this.flush(),this.colorStackIndex--;let e=this.colorStack[this.colorStackIndex-1];e!==this.currentColor&&(this.currentColor=e,this.instructions.push({t:`colorMask`,colorMask:e}))}pushStencilMask(e,t){this.flush();let n=!!e._maskOptions.inverse;this.instructions.push({t:`pushMaskBegin`,inverse:n});let r=this.instructions.length,i=t.mask;si(i,this.root,this.tick),i.includeInBuild=!0,this.collect(i),i.includeInBuild=!1,this.flush();let a=this.instructions.length;this.instructions.push({t:`pushMaskEnd`,inverse:n}),this.maskRanges.set(t,[r,a])}popStencilMask(e,t){this.flush(),this.instructions.push({t:`popMaskBegin`,inverse:!!e._maskOptions.inverse});let n=this.maskRanges.get(t);if(n)for(let e=n[0];e<n[1];e++)this.instructions.push(this.instructions[e]);this.instructions.push({t:`popMaskEnd`})}flush(){this.batches.length=0,this.batcher.break(this.batches);for(let e of this.batches)this.instructions.push(e)}},ui=`struct GlobalFilterUniforms {
  uInputSize:vec4<f32>,
  uInputPixel:vec4<f32>,
  uInputClamp:vec4<f32>,
  uOutputFrame:vec4<f32>,
  uGlobalFrame:vec4<f32>,
  uOutputTexture:vec4<f32>,
};

struct MaskUniforms {
  uFilterMatrix:mat3x3<f32>,
  uMaskClamp:vec4<f32>,
  uAlpha:f32,
  uInverse:f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler : sampler;

@group(1) @binding(0) var<uniform> filterUniforms : MaskUniforms;
@group(1) @binding(1) var uMaskTexture: texture_2d<f32>;
@group(1) @binding(2) var uMaskSampler: sampler;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv : vec2<f32>,
    @location(1) filterUv : vec2<f32>,
};

fn filterVertexPosition(aPosition:vec2<f32>) -> vec4<f32>
{
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;

    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

fn globalTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
  return  (aPosition.xy / gfu.uGlobalFrame.zw) + (gfu.uGlobalFrame.xy / gfu.uGlobalFrame.zw);
}

fn getFilterCoord(aPosition:vec2<f32> ) -> vec2<f32>
{
  return ( filterUniforms.uFilterMatrix * vec3( filterTextureCoord(aPosition), 1.0)  ).xy;
}

fn getSize() -> vec2<f32>
{
  return gfu.uGlobalFrame.zw;
}

@vertex
fn mainVertex(
  @location(0) aPosition : vec2<f32>,
) -> VSOutput {
  return VSOutput(
   filterVertexPosition(aPosition),
   filterTextureCoord(aPosition),
   getFilterCoord(aPosition)
  );
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @location(1) filterUv: vec2<f32>,
  @builtin(position) position: vec4<f32>
) -> @location(0) vec4<f32> {

    var maskClamp = filterUniforms.uMaskClamp;
    var uAlpha = filterUniforms.uAlpha;

    var clip = step(3.5,
      step(maskClamp.x, filterUv.x) +
      step(maskClamp.y, filterUv.y) +
      step(filterUv.x, maskClamp.z) +
      step(filterUv.y, maskClamp.w));

    var mask = textureSample(uMaskTexture, uMaskSampler, filterUv);
    var source = textureSample(uTexture, uSampler, uv);
    var alphaMul = 1.0 - uAlpha * (1.0 - mask.a);

    var a: f32 = alphaMul * mask.r * uAlpha * clip;

    if (filterUniforms.uInverse == 1.0) {
        a = 1.0 - a;
    }

    return source * a;
}
`,di=class extends $t{constructor(e){let{sprite:t,inverse:n,...r}=e,i=new ge(t.texture),a=new Pt({uFilterMatrix:{value:new S,type:`mat3x3<f32>`},uMaskClamp:{value:i.uClampFrame,type:`vec4<f32>`},uAlpha:{value:1,type:`f32`},uInverse:{value:n?1:0,type:`f32`}}),o=Lt.from({vertex:{source:ui,entryPoint:`mainVertex`},fragment:{source:ui,entryPoint:`mainFragment`}});super({...r,gpuProgram:o,clipToViewport:!1,resources:{filterUniforms:a,uMaskTexture:t.texture.source,uMaskSampler:t.texture.source.style}}),this.spriteWorldTransform=null,this.sprite=t,this._textureMatrix=i}set inverse(e){this.resources.filterUniforms.uniforms.uInverse=e?1:0}get inverse(){return this.resources.filterUniforms.uniforms.uInverse===1}apply(e,t,n,r){this._textureMatrix.texture=this.sprite.texture,e.calculateSpriteMatrix(this.resources.filterUniforms.uniforms.uFilterMatrix,this.sprite,this.spriteWorldTransform??void 0).prepend(this._textureMatrix.mapCoord),this.resources.uMaskTexture=this.sprite.texture.source,this.resources.uMaskSampler=this.sprite.texture.source.style,e.applyFilter(this,t,n,r)}},fi=class{constructor(){this.buf=new ArrayBuffer(64*1024),this.f32=new Float32Array(this.buf),this.i32=new Int32Array(this.buf),this.u32=new Uint32Array(this.buf),this.size=0}reset(){this.size=0}alloc(e){let t=Math.ceil(this.size/256)*256,n=t+Math.max(16,Math.ceil(e/16)*16);return n>this.buf.byteLength&&this.grow(n),new Uint8Array(this.buf,t,n-t).fill(0),this.size=n,t}equal(e,t,n){let r=this.u32,i=e/4,a=t/4,o=Math.ceil(n/4);for(let e=0;e<o;e++)if(r[i+e]!==r[a+e])return!1;return!0}get bytes(){return new Uint8Array(this.buf,0,Math.ceil(this.size/4)*4)}grow(e){let t=this.buf.byteLength;for(;t<e;)t*=2;let n=new ArrayBuffer(t);new Uint8Array(n).set(new Uint8Array(this.buf)),this.buf=n,this.f32=new Float32Array(n),this.i32=new Int32Array(n),this.u32=new Uint32Array(n)}},pi=new Lt({name:`engine2d-batch`,vertex:{source:Wr,entryPoint:`mainVertex`},fragment:{source:Wr,entryPoint:`mainFragment`}}),mi=new Lt({name:`engine2d-graphics`,vertex:{source:Gr,entryPoint:`mainVertex`},fragment:{source:Gr,entryPoint:`mainFragment`}}),hi=new Lt({name:`engine2d-mesh`,vertex:{source:Kr,entryPoint:`mainVertex`},fragment:{source:Kr,entryPoint:`mainFragment`}});function gi(e,t,n,r){return{globalUniforms:e,localUniforms:t,textureSource1:n[0],textureSampler1:r[0],textureSource2:n[1],textureSampler2:r[1],textureSource3:n[2],textureSampler3:r[2],textureSource4:n[3],textureSampler4:r[3],textureSource5:n[4],textureSampler5:r[4],textureSource6:n[5],textureSampler6:r[5],textureSource7:n[6],textureSampler7:r[6],textureSource8:n[7],textureSampler8:r[7],textureSource9:n[8],textureSampler9:r[8],textureSource10:n[9],textureSampler10:r[9],textureSource11:n[10],textureSampler11:r[10],textureSource12:n[11],textureSampler12:r[11],textureSource13:n[12],textureSampler13:r[12],textureSource14:n[13],textureSampler14:r[13],textureSource15:n[14],textureSampler15:r[14],textureSource16:n[15],textureSampler16:r[15]}}var _i={key:`engine2d-batch`,buffers:[{name:`stream0`,stride:24,stepMode:`vertex`,attributes:[{name:`aPosition`,format:`float32x2`,offset:0},{name:`aUV`,format:`float32x2`,offset:8},{name:`aColor`,format:`unorm8x4`,offset:16},{name:`aTextureIdAndRound`,format:`uint16x2`,offset:20}]}],sources:[]},vi=new Ct({attributes:{aPosition:{buffer:new Float32Array([0,0,1,0,1,1,0,1]),format:`float32x2`,stride:8,offset:0}},indexBuffer:new Uint32Array([0,1,2,0,2,3])}),yi=Tt([{name:`uProjectionMatrix`,type:`mat3x3<f32>`,size:1},{name:`uWorldTransformMatrix`,type:`mat3x3<f32>`,size:1},{name:`uWorldColorAlpha`,type:`vec4<f32>`,size:1},{name:`uResolution`,type:`vec2<f32>`,size:1},{name:`uRoundFlipY`,type:`f32`,size:1}]),bi=Tt([{name:`uTransformMatrix`,type:`mat3x3<f32>`,size:1},{name:`uColor`,type:`vec4<f32>`,size:1},{name:`uRound`,type:`f32`,size:1}]),xi=Tt([{name:`uTextureMatrix`,type:`mat3x3<f32>`,size:1}]),Si=Tt([{name:`uInputSize`,type:`vec4<f32>`,size:1},{name:`uInputPixel`,type:`vec4<f32>`,size:1},{name:`uInputClamp`,type:`vec4<f32>`,size:1},{name:`uOutputFrame`,type:`vec4<f32>`,size:1},{name:`uGlobalFrame`,type:`vec4<f32>`,size:1},{name:`uOutputTexture`,type:`vec4<f32>`,size:1}]);function Ci(e,t,n){let r=(e>>24&255)/255;t[n++]=(e&255)/255*r,t[n++]=(e>>8&255)/255*r,t[n++]=(e>>16&255)/255*r,t[n++]=r}function wi(e,t,n,r,i,a){let o=a?1:-1;return e.identity(),e.a=1/r*2,e.d=o*(1/i*2),e.tx=-1-t*e.a,e.ty=-o-n*e.d,e}function Ti(e){return(e&8)>>3|(e&4)>>1|(e&2)<<1|(e&1)<<3}var Ei=class{constructor(){this.skip=!1,this.inputTexture=null,this.backTexture=null,this.filters=null,this.bounds=new L,this.container=null,this.blendRequired=!1,this.outputRenderSurface=null,this.globalFrame={x:0,y:0,width:0,height:0},this.firstEnabledIndex=-1,this.lastEnabledIndex=-1,this.resolution=1,this.antialias=!1}},Di=class{constructor(e){this.makePassthrough=e,this.commands=[],this.arena=new fi,this.currentSurface=`canvas`,this.rootViewPort=new E,this.viewport=new E,this.projectionMatrix=new S,this.targetStack=[],this.passStencil=!1,this.passSamples=1,this.guStack=[],this.stencilState=new Map,this.maskStack=new Map,this.colorMask=15,this.filterStack=[],this.filterStackIndex=0,this.activeFilterData=null,this.passthrough=null,this.activeMaskStage=[],this.alphaMaskPool=[],this.groupSlices=new Map,this.borrowed=new Set,this.filterScratch={outputFrame:new Float32Array(4),inputSize:new Float32Array(4),inputPixel:new Float32Array(4),inputClamp:new Float32Array(4),globalFrame:new Float32Array(4),outputTexture:new Float32Array(4)},this.colorScratch=new Float32Array(4),this.localScratch={uTransformMatrix:null,uColor:this.colorScratch,uRound:0},this.batchTextureScratch=[],this.batchSamplerScratch=[],this.arenaRefs=[]}begin(e){this.ctx=e,this.commands.length=0,this.arena.reset(),this.guStack=[],this.stencilState.clear(),this.maskStack.clear(),this.colorMask=15,this.filterStackIndex=0,this.activeFilterData=null,this.activeMaskStage.length=0,this.groupSlices.clear(),this.arenaRefs.length=0,this.passStencil=!1}abort(){for(let e of this.borrowed)Se.returnTexture(e);this.borrowed.clear()}takePoolTexture(e,t,n,r){let i=Se.getOptimalTexture(e,t,n,r);return this.borrowed.add(i),i}returnPoolTexture(e){this.borrowed.delete(e),Se.returnTexture(e)}bindUniformBuffer(e){let t=this.arenaRefs;for(let n=0;n<t.length;n++)t[n].buffer=e}arenaRef(e,t){let n={buffer:null,offset:e,size:t};return this.arenaRefs.push(n),n}renderStart(e,t,n){this.targetStack.length=0,this.pushRenderTarget(e,t,n),this.rootViewPort.copyFrom(this.viewport),this.rootTarget=this.current}pushRenderTarget(e,t,n){this.bind(e,t,n),this.targetStack.push(e)}popRenderTarget(){this.targetStack.pop(),this.bind(this.targetStack[this.targetStack.length-1],!1)}bind(e,t,n,r){let i=this.resolveTarget(e);this.current=i,this.currentSurface=e,!r&&e instanceof I&&(r=e.frame);let a=this.viewport;if(r){let e=i.resolution,t=r.x*e+.5|0,n=r.y*e+.5|0,o=r.width*e+.5|0,s=r.height*e+.5|0,c=t,l=n,u=o,d=s;c=Math.min(Math.max(c,0),i.pixelWidth-1),l=Math.min(Math.max(l,0),i.pixelHeight-1),u=Math.min(Math.max(u,1),i.pixelWidth-c),d=Math.min(Math.max(d,1),i.pixelHeight-l),a.x=c,a.y=l,a.width=u,a.height=d}else a.x=0,a.y=0,a.width=i.pixelWidth,a.height=i.pixelHeight;wi(this.projectionMatrix,0,0,a.width/i.resolution,a.height/i.resolution,i.ref===`canvas`),this.startPass(t,n??[0,0,0,0],t)}startPass(e,t,n){let r=this.current,i=this.ctx.stencilTargets.has(r.key),a=Pr(r.antialias,r.format);this.passStencil=i,this.passSamples=a,this.commands.push({t:`pass`,target:r.ref,color:r.color,load:e?`clear`:`load`,clearColor:t,stencil:i,stencilLoad:n?`clear`:`load`,viewport:[this.viewport.x,this.viewport.y,this.viewport.width,this.viewport.height],samples:a})}ensureDepthStencil(){let e=this.current.key;this.ctx.stencilTargets.has(e)?this.passStencil||this.startPass(!1,[0,0,0,0],!1):(this.ctx.stencilTargets.add(e),this.startPass(!1,[0,0,0,0],!1))}resolveTarget(e){if(e===`canvas`||typeof HTMLCanvasElement<`u`&&e instanceof HTMLCanvasElement){let e=this.ctx.canvas;return{ref:`canvas`,key:this.ctx.canvasStencilKey,color:null,format:e.format,pixelWidth:e.pixelWidth,pixelHeight:e.pixelHeight,resolution:e.resolution,width:e.pixelWidth/e.resolution,height:e.pixelHeight/e.resolution,antialias:e.antialias}}let t=e instanceof I?e.source:e,n=this.ctx.textures.get(t,!0);return{ref:t,key:t,color:n,format:n.format,pixelWidth:t.pixelWidth,pixelHeight:t.pixelHeight,resolution:t._resolution,width:t.width,height:t.height,antialias:t.antialias}}globalStart(e){this.guStack=[],this.globalPush(e)}globalPush(e){let t=this.guStack.length?this.guStack[this.guStack.length-1]:null,n={worldTransformMatrix:t?.worldTransformMatrix??new S,worldColor:t?.worldColor??4294967295,offset:t?.offset??{x:0,y:0}},r={projectionMatrix:(e.projectionMatrix??this.projectionMatrix).clone(),resolution:[this.current.pixelWidth,this.current.pixelHeight],worldTransformMatrix:e.worldTransformMatrix??n.worldTransformMatrix,worldColor:e.worldColor??n.worldColor,offset:e.offset??n.offset,arena:this.arenaRef(0,yi.size)},i=r.worldTransformMatrix.clone();i.tx-=r.offset.x,i.ty-=r.offset.y;let a=this.colorScratch;Ci(r.worldColor,a,0),r.arena.offset=this.writeUbo(yi,{uProjectionMatrix:r.projectionMatrix,uWorldTransformMatrix:i,uWorldColorAlpha:a,uResolution:r.resolution,uRoundFlipY:1}),this.guStack.push(r),this.currentGU=r}globalPop(){this.guStack.pop(),this.currentGU=this.guStack[this.guStack.length-1]}execute(e){switch(e.t){case`batch`:this.drawBatch(e);return;case`custom`:this.drawCustom(e.drawable);return;case`unbatched`:this.drawUnbatched(e.item,e.batches);return;case`pushFilter`:this.filterPush(e.container,e.effect);return;case`popFilter`:this.filterPop();return;case`pushAlphaMaskBegin`:case`pushAlphaMaskEnd`:case`popAlphaMaskEnd`:this.alphaMaskExecute(e);return;case`colorMask`:this.colorMask=e.colorMask;return;default:this.maskExecute(e)}}drawUnbatched(e,t){if(!e.isRenderable)return;let n=this.arenaRef(this.writeLocal(e.groupTransform,e.groupColorAlpha,this.ctx.roundPixels|e._roundPixels),bi.size);for(let r of t)this.drawBatch(r,mi,e.groupBlendMode,n)}drawBatch(e,t=pi,n=e.blendMode,r){let i=I.EMPTY.source,a=this.ctx.textures,o=this.batchTextureScratch,s=this.batchSamplerScratch;for(let t=0;t<16;t++){let n=e.textures[t]??i;o[t]=a.get(n),s[t]=a.sampler(n.style)}let c=gi(this.currentGU.arena,r,o,s);this.pushDraw({program:t,layout:_i,topology:e.topology,blend:n,bindings:c,streams:[{name:`stream0`,buffer:`batch`}],index:`batch`,count:e.size,first:e.start,instances:1})}drawCustom(e){let t=e;if(t.isRenderable===!1)return;let n=e.shader,r=e.texture,i=qr(e.groupBlendMode,r.source),a=this.arenaRef(this.writeLocal(e.groupTransform,e.groupColorAlpha,this.ctx.roundPixels|(t._roundPixels??0)),bi.size);if(n&&!n.gpuProgram){gt(`Mesh shader has no gpuProgram`,n);return}let o=n?n.gpuProgram:hi,s={globalUniforms:this.currentGU.arena,localUniforms:a};n?(this.resolveResources(n,s),`uTexture`in s||(s.uTexture=this.ctx.textures.get(r.source),`uSampler`in s||(s.uSampler=this.ctx.textures.sampler(r.source.style)))):(s.uTexture=this.ctx.textures.get(r.source),s.uSampler=this.ctx.textures.sampler(r.source.style),s.textureUniforms=this.arenaRef(this.writeUbo(xi,{uTextureMatrix:r.textureMatrix.mapCoord}),xi.size)),this.drawGeometry(o,e.geometry,i,s)}drawGeometry(e,t,n,r,i){let a=this.ctx.pipelines.layout(t,e),o=t.attributes,s=a.buffers.map((e,t)=>({name:e.name,buffer:this.ctx.buffers.get(o[a.sources[t]].buffer)})),c=t.indexBuffer?this.ctx.buffers.get(t.indexBuffer):null,l=t.indexBuffer?t.indexBuffer.data.length:t.getSize();this.pushDraw({program:e,layout:a,topology:t.topology,blend:n,bindings:r,streams:s,index:c,count:l,first:0,instances:i??t.instanceCount})}pushDraw(e){if(e.count<=0)return;let t=this.stencilState.get(this.current.key)??{mode:`disabled`,ref:0};this.commands.push({t:`draw`,pipeline:{program:e.program,layout:e.layout,topology:e.topology,blend:e.blend,colorFormat:this.current.format,depthFormat:this.passStencil?jr:null,stencil:t.mode,colorMask:Ti(this.colorMask),sampleCount:this.passSamples},bindings:e.bindings,streams:e.streams,index:e.index,count:e.count,first:e.first,instances:e.instances,stencilRef:t.ref})}resolveResources(e,t){let n=e.resources;for(let e in n){let r=n[e];r!=null&&(r instanceof Pt?t[e]=this.snapshotGroup(r):r instanceof le?t[e]=this.ctx.textures.get(r):r instanceof I?t[e]=this.ctx.textures.get(r.source):r._resourceType===`textureSampler`?t[e]=this.ctx.textures.sampler(r):r instanceof ft?t[e]=this.ctx.buffers.get(r):r instanceof pt&&(t[e]={buffer:this.ctx.buffers.get(r.buffer),offset:r.offset,size:r.size||void 0}))}}snapshotGroup(e){let t=e.layout,n=this.arena.size,r=this.writeUbo(t,e.uniforms),i=this.groupSlices.get(e);if(i&&this.arena.equal(i.offset,r,t.size))return this.arena.size=n,i;let a=this.arenaRef(r,t.size);return this.groupSlices.set(e,a),a}writeLocal(e,t,n){let r=this.localScratch;Ci(t,r.uColor,0),r.uTransformMatrix=e,r.uRound=n;let i=this.writeUbo(bi,r);return r.uTransformMatrix=null,i}writeUbo(e,t){let n=this.arena.alloc(e.size);return At(e,t,this.arena.f32,this.arena.i32,this.arena.u32,n/4),n}setStencilMode(e,t){this.stencilState.set(this.current.key,{mode:e,ref:t})}maskExecute(e){let t=this.current.key,n=this.maskStack.get(t)??0;e.t===`pushMaskBegin`?(this.ensureDepthStencil(),this.setStencilMode(`add`,n),n++,this.colorMask=0):e.t===`pushMaskEnd`?(this.setStencilMode(e.inverse?`inverse`:`active`,n),this.colorMask=15):e.t===`popMaskBegin`?(this.colorMask=0,n===0?(this.startPass(!1,[0,0,0,0],!0),this.setStencilMode(`disabled`,n)):this.setStencilMode(`remove`,n),n--):e.t===`popMaskEnd`&&(this.setStencilMode(`active`,n),this.colorMask=15),this.maskStack.set(t,n)}alphaMaskExecute(e){let t=e.mask.renderMaskToTexture;if(e.t===`pushAlphaMaskBegin`){let n=this.alphaMaskPool.pop()??Oi();if(n.filter.inverse=e.inverse,t){let t=e.mask.mask;t.measurable=!0;let r=this.maskGlobalBounds(t,n.bounds);t.measurable=!1,r.ceil();let i=this.current,a=this.takePoolTexture(r.width,r.height,i.resolution,i.antialias);this.pushRenderTarget(a,!0),this.globalPush({offset:r,worldColor:4294967295});let o=n.internalSprite;o.texture=a,n.internalWorld.set(1,0,0,1,r.minX,r.minY),n.filter.sprite=o,n.filter.spriteWorldTransform=n.internalWorld,this.activeMaskStage.push({entry:n,maskedContainer:e.container,filterTexture:a})}else n.filter.sprite=e.mask.mask,n.filter.spriteWorldTransform=null,this.activeMaskStage.push({entry:n,maskedContainer:e.container})}else if(e.t===`pushAlphaMaskEnd`){let e=this.activeMaskStage[this.activeMaskStage.length-1];t&&(this.popRenderTarget(),this.globalPop()),this.filterPush(e.maskedContainer,e.entry.effect)}else{this.filterPop();let e=this.activeMaskStage.pop();t&&this.returnPoolTexture(e.filterTexture),e.entry.filter.sprite=e.entry.internalSprite,this.alphaMaskPool.push(e.entry)}}maskGlobalBounds(e,t){t.clear();let n=this.guStack[0].worldTransformMatrix;return ki(e,t,n),t.isValid||t.set(0,0,0,0),t}calculateSpriteMatrix(e,t,n){let r=this.activeFilterData,i=e.set(r.inputTexture.source.width,0,0,r.inputTexture.source.height,r.bounds.minX,r.bounds.minY),a=n?n.clone():new S().appendFrom(t.groupTransform,this.guStack[0].worldTransformMatrix);return a.invert(),i.prepend(a),i.scale(1/t.texture.orig.width,1/t.texture.orig.height),i.translate(t.anchor.x,t.anchor.y),i}filterPush(e,t){let n=t.filters??[],r=this.pushFilterData();r.skip=!1,r.filters=n,r.container=e,r.outputRenderSurface=this.currentSurface;let i=this.current.resolution,a=this.current.antialias;if(n.every(e=>!e.enabled)){r.skip=!0;return}let o=r.bounds;if(this.calculateFilterArea(e,t,o),this.calculateFilterBounds(r,this.rootViewPort,a,i,1),r.skip)return;let s=this.getPreviousFilterData(),c=this.findFilterResolution(i),l=0,u=0;s&&(l=s.bounds.minX,u=s.bounds.minY);let d=r.globalFrame;d.x=l*c,d.y=u*c,d.width=this.current.width*c,d.height=this.current.height*c,r.backTexture=I.EMPTY,r.inputTexture=this.takePoolTexture(o.width,o.height,r.resolution,r.antialias),r.blendRequired&&(r.backTexture=this.getBackTexture(o,s?.bounds)),this.bind(r.inputTexture,!0),this.globalPush({offset:o})}filterPop(){let e=this.popFilterData();e.skip||(this.globalPop(),this.activeFilterData=e,this.applyFiltersToTexture(e,!1),e.blendRequired&&e.backTexture&&this.returnPoolTexture(e.backTexture),this.returnPoolTexture(e.inputTexture))}getBackTexture(e,t){let n=this.current.resolution;this.takePoolTexture(e.width,e.height,n,!1);let r=e.minX,i=e.minY;throw t&&(r-=t.minX,i-=t.minY),r=Math.floor(r*n),i=Math.floor(i*n),Error(`[engine2d] blendRequired 滤镜暂不支持(运行时未用到)`)}filterPassOrigin(e){let t=this.activeFilterData;return t?t.outputRenderSurface===e?this.findPreviousFilterOffset():{x:t.bounds.minX,y:t.bounds.minY}:{x:0,y:0}}applyFilter(e,t,n,r){let i=this.activeFilterData,a=i.outputRenderSurface===n,o=this.rootTarget.resolution,s=this.findFilterResolution(o),c=0,l=0;if(a){let e=this.findPreviousFilterOffset();c=e.x,l=e.y}let u=this.updateFilterUniforms(t,n,i,c,l,s,a,r),d=e.enabled?e:this.getPassthrough(),f={};this.resolveResources(d,f),f.gfu=u,f.uTexture=this.ctx.textures.get(t.source),f.uSampler=this.ctx.textures.sampler(t.source.style),i.backTexture&&(f.uBackTexture=this.ctx.textures.get(i.backTexture.source));let p=d.gpuProgram;if(!p)throw Error(`[engine2d] 滤镜没有 WGSL 程序(gpuProgram)`);this.drawGeometry(p,vi,d.blendMode,f)}updateFilterUniforms(e,t,n,r,i,a,o,s){let{outputFrame:c,inputSize:l,inputPixel:u,inputClamp:d,globalFrame:f,outputTexture:p}=this.filterScratch;c.fill(0),l.fill(0),u.fill(0),d.fill(0),f.fill(0),p.fill(0),o&&(c[0]=n.bounds.minX-r,c[1]=n.bounds.minY-i),c[2]=e.frame.width,c[3]=e.frame.height,l[0]=e.source.width,l[1]=e.source.height,l[2]=1/l[0],l[3]=1/l[1],u[0]=e.source.pixelWidth,u[1]=e.source.pixelHeight,u[2]=1/u[0],u[3]=1/u[1],d[0]=.5*u[2],d[1]=.5*u[3],d[2]=e.frame.width*l[2]-.5*u[2],d[3]=e.frame.height*l[3]-.5*u[3];let m=this.rootTarget;return f[0]=r*a,f[1]=i*a,f[2]=m.width*a,f[3]=m.height*a,this.bind(t,!!s),t instanceof I?(p[0]=t.frame.width,p[1]=t.frame.height):(p[0]=this.current.width,p[1]=this.current.height),p[2]=this.current.ref===`canvas`?1:-1,this.arenaRef(this.writeUbo(Si,{uInputSize:l,uInputPixel:u,uInputClamp:d,uOutputFrame:c,uGlobalFrame:f,uOutputTexture:p}),Si.size)}getPassthrough(){return this.passthrough??=this.makePassthrough()}findFilterResolution(e){let t=this.filterStackIndex-1;for(;t>0&&this.filterStack[t].skip;)--t;return t>0&&this.filterStack[t].inputTexture?this.filterStack[t].inputTexture.source._resolution:e}findPreviousFilterOffset(){let e=0,t=0,n=this.filterStackIndex;for(;n>0;){n--;let r=this.filterStack[n];if(!r.skip){e=r.bounds.minX,t=r.bounds.minY;break}}return{x:e,y:t}}calculateFilterArea(e,t,n){let r=this.currentGU?this.guStack[0].worldTransformMatrix:S.IDENTITY;if(t.filterArea){n.clear(),n.addRect(t.filterArea),n.applyMatrix(new S().appendFrom(e.groupTransform,r));return}n.clear(),Ai(e,n,r),n.isValid||n.set(0,0,0,0),n.applyMatrix(r)}calculateFilterBounds(e,t,n,r,i){let a=e.bounds,o=e.filters,s=1/0,c=0,l=!0,u=!1,d=!1,f=!0,p=-1,m=-1;for(let e=0;e<o.length;e++){let t=o[e];if(t.enabled){if(p===-1&&(p=e),m=e,s=Math.min(s,t.resolution===`inherit`?r:t.resolution),c+=t.padding,t.antialias===`off`?l=!1:t.antialias===`inherit`&&(l&&=n),t.clipToViewport||(f=!1),!(t.compatibleRenderers&2)){d=!1;break}d=!0,u||=t.blendRequired}}if(!d){e.skip=!0;return}if(f&&a.fitBounds(0,t.width/r,0,t.height/r),a.scale(s).ceil().scale(1/s).pad((c|0)*i),!a.isPositive){e.skip=!0;return}e.antialias=l,e.resolution=s,e.blendRequired=u,e.firstEnabledIndex=p,e.lastEnabledIndex=m}applyFiltersToTexture(e,t){let n=e.inputTexture,r=e.bounds,i=e.filters,a=e.firstEnabledIndex,o=e.lastEnabledIndex,s=e.outputRenderSurface;if(a===o)i[a].apply(this,n,s,t);else{let e=n,c=this.takePoolTexture(r.width,r.height,e.source._resolution,!1),l=c;for(let t=a;t<o;t++){let n=i[t];if(!n.enabled)continue;n.apply(this,e,l,!0);let r=e;e=l,l=r}i[o].apply(this,e,s,t),this.returnPoolTexture(c)}}popFilterData(){return this.filterStackIndex--,this.filterStack[this.filterStackIndex]}getPreviousFilterData(){let e,t=this.filterStackIndex-1;for(;t>0&&(t--,e=this.filterStack[t],e.skip););return e}pushFilterData(){let e=this.filterStack[this.filterStackIndex];return e||=this.filterStack[this.filterStackIndex]=new Ei,this.filterStackIndex++,e}};function Oi(){let e=new ut(I.EMPTY),t=new di({sprite:e,inverse:!1,resolution:`inherit`,antialias:`inherit`}),n=new Re;return n.filters=[t],{effect:n,filter:t,internalSprite:e,internalWorld:new S,bounds:new L}}function ki(e,t,n){if(!e._activeSelf||!e.visible||!e.measurable)return;let r=new S().appendFrom(e.groupTransform,n),i=t,a=e.effects.length>0;if(a&&(t=new L),e.boundsArea)t.addRect(e.boundsArea,r);else{let i=e.bounds;i&&!i.isEmpty()&&(t.matrix=r,t.addBounds(i));for(let r of e.children)ki(r,t,n)}if(a){for(let n of e.effects)n.addBounds?.(t);i.addBounds(t,S.IDENTITY)}}function Ai(e,t,n){if(!e._activeSelf||e.localDisplayStatus!==7||!e.measurable)return;let r=e.effects.length>0,i=r?new L:t;if(e.boundsArea)i.addRect(e.boundsArea,e.groupTransform);else{if(e.renderPipeId){let t=e.bounds;t&&i.addFrame(t.minX,t.minY,t.maxX,t.maxY,e.groupTransform)}for(let t of e.children)Ai(t,i,n)}if(r){let r=!1;for(let t of e.effects)t.addBounds&&(r||(r=!0,i.applyMatrix(n)),t.addBounds(i));r&&i.applyMatrix(n.clone().invert()),t.addBounds(i)}}var ji=`
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>
};
fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}
@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}
@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, uv);
}
`,Mi=`
@group(0) @binding(0) var uCanvasFlip: texture_2d<f32>;
@vertex
fn mainVertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
@fragment
fn mainFragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let h = i32(textureDimensions(uCanvasFlip).y);
  return textureLoad(uCanvasFlip, vec2<i32>(i32(p.x), h - 1 - i32(p.y)), 0);
}
`,Ni=new Lt({name:`engine2d-canvas-flip`,vertex:{source:Mi,entryPoint:`mainVertex`},fragment:{source:Mi,entryPoint:`mainFragment`}}),Pi={key:`engine2d-canvas-flip`,buffers:[],sources:[]};function Fi(){return new $t({gpuProgram:Lt.from({name:`engine2d-passthrough`,vertex:{source:ji,entryPoint:`mainVertex`},fragment:{source:ji,entryPoint:`mainFragment`}}),resources:{}})}var Ii=class{constructor(e){this.batcher=new Jr,this.builder=new Di(Fi),this.vertexBuffer=null,this.indexBuffer=null,this.uniformBuffer=null,this.collector=new li(this.batcher,1,e)}},Li=class extends yr{constructor(e){super(e),this.states=[],this.depth=0,this.targets=new Map,this.stencilTargets=new WeakSet,this.canvasKey={},this.canvasFlip=null,this.destroyed=!1,this.contextChangePending=!1,this.prewarmSpecs=[],this.ownsDevice=!1,this.antialias=!!e.antialias,this.scope=this.rhi.createScope(`engine2d`),this.gc=new Or(e),this.textures=new Cr(this.rhi,this.scope,this.gc),this.textures.onRelease=e=>this.releaseTargets(e),this.buffers=new Tr(this.rhi,this.scope,this.gc),this.gc.addCollector((e,t)=>this.textures.collect(e,t)),this.gc.addCollector((e,t)=>this.buffers.collect(e,t)),this.pipelines=new Rr(this.scope),this.extract=Vi(this),this.offRestored=this.rhi.onRestored(()=>this.contextChange())}contextChange(){if(!this.destroyed){if(this.depth>0){this.contextChangePending=!0;return}this.contextChangePending=!1;for(let e of[...this.targets.keys()])this.releaseTargets(e);this.canvasFlip?.destroy(),this.canvasFlip=null,this.pipelines.reset(),this.buffers.reset(),this.textures.reset();for(let e of this.states)e.vertexBuffer=null,e.indexBuffer=null,e.uniformBuffer=null;this.buildPrewarm(this.prewarmSpecs)}}render(e){if(this.destroyed)return;let t=e instanceof Ye?{container:e}:{...e},n=t.container,r=!t.target||t.target===this.canvas,i=t.clear,a=t.clearColor;r&&(this.lastObjectRendered=n,a??=this.background.colorRgba,i??=this.background.clearBeforeRender),i??=!0;let o=Ri(a),s=t.transform;if(s||=(n.updateLocalTransform(),n.localTransform),!n.visible||!n.activeSelf)return;let c=Ye._nextRenderTick();this.gc.prerender(),ri(n,this,c,s);let l=this.states[this.depth]??=new Ii(this);this.depth++;try{let{collector:e,builder:a}=l;e.begin(n,c,this.resolution),e.collectRoot(n),a.begin({textures:this.textures,buffers:this.buffers,pipelines:this.pipelines,canvas:{format:this.rhi.caps.swapchainFormat,pixelWidth:this.canvas.width,pixelHeight:this.canvas.height,resolution:this.resolution,antialias:this.antialias},roundPixels:this.roundPixels?1:0,stencilTargets:this.stencilTargets,canvasStencilKey:this.canvasKey}),a.renderStart(r?`canvas`:t.target,i,o);let u=Math.min(1,Math.max(0,n.localAlpha));a.globalStart({worldTransformMatrix:s.clone(),worldColor:n.localColor+((u*255|0)<<24)});for(let t of e.instructions)a.execute(t);this.upload(l);let d=a.commands,f=d.some(e=>e.t===`pass`&&e.target===`canvas`);if(f&&(this.canvas.width===0||this.canvas.height===0))return;f?this.rhi.runFrame(e=>this.record(l,d,e.commands,e)):this.rhi.submit(`engine2d render`,e=>this.record(l,d,e,null))}catch(e){throw l.builder.abort(),e}finally{this.depth--,this.depth===0&&(this.contextChangePending&&this.contextChange(),this.gc.postrender())}}upload(e){let{batcher:t,builder:n}=e,r=t.attributeSize*4;r>0&&(e.vertexBuffer=this.ensureBuffer(e.vertexBuffer,r,z.VERTEX|z.COPY_DST,`engine2d-batch-vertices`),this.rhi.writeBuffer(e.vertexBuffer,new Uint8Array(t.attr,0,r)));let i=t.indexSize*4;i>0&&(e.indexBuffer=this.ensureBuffer(e.indexBuffer,i,z.INDEX|z.COPY_DST,`engine2d-batch-indices`,`uint32`),this.rhi.writeBuffer(e.indexBuffer,new Uint8Array(t.indices.buffer,0,i)));let a=n.arena.bytes;a.byteLength>0&&(e.uniformBuffer=this.ensureBuffer(e.uniformBuffer,a.byteLength,z.UNIFORM|z.COPY_DST,`engine2d-uniforms`),this.rhi.writeBuffer(e.uniformBuffer,a)),n.bindUniformBuffer(e.uniformBuffer)}ensureBuffer(e,t,n,r,i){if(e&&e.size>=t)return e;e?.destroy();let a=64*1024;for(;a<t;)a*=2;return this.scope.createBuffer({label:r,usage:n,size:a,indexFormat:i})}record(e,t,n,r){let i=null,a=0,o=0;for(let s of t){if(s.t===`pass`){i?.end();let e=this.passTarget(s,r);i=n.beginRenderPass({label:`engine2d pass ${o++}`,target:e,colorOps:[s.load===`clear`?{load:`clear`,clearValue:s.clearColor}:{load:`load`}],depthOp:{load:`clear`,clearValue:1},stencilOp:s.stencilLoad===`clear`?{load:`clear`,clearValue:0}:{load:`load`}}),i.setViewport(s.viewport[0],s.viewport[1],s.viewport[2],s.viewport[3]),a=0;continue}if(!i)throw Error(`[engine2d] 绘制命令之前没有 pass`);i.setPipeline(this.pipelines.get(s.pipeline)),i.setBindings(s.bindings);for(let t of s.streams)i.setVertexBuffer(t.name,t.buffer===`batch`?e.vertexBuffer:t.buffer);s.pipeline.depthFormat&&s.stencilRef!==a&&(i.setStencilReference(s.stencilRef),a=s.stencilRef),s.index?(i.setIndexBuffer(s.index===`batch`?e.indexBuffer:s.index),i.drawIndexed(s.count,s.instances,s.first)):(i.setIndexBuffer(null),i.draw(s.count,s.instances,s.first))}i?.end(),r&&this.canvasFlip&&t.some(e=>e.t===`pass`&&e.target===`canvas`)&&this.presentCanvasFlip(n,r,this.canvasFlip)}presentCanvasFlip(e,t,n){let r=e.beginRenderPass({label:`engine2d 画布翻转上屏`,target:t.swapchain,colorOps:[{load:`clear`,clearValue:[0,0,0,0]}]});r.setViewport(0,0,n.width,n.height),r.setPipeline(this.canvasFlipPipeline()),r.setBindings({uCanvasFlip:n}),r.setIndexBuffer(null),r.draw(3,1,0),r.end()}canvasFlipPipeline(){return this.pipelines.get({program:Ni,layout:Pi,topology:`triangle-list`,blend:`none`,colorFormat:this.rhi.caps.swapchainFormat,depthFormat:null,stencil:`disabled`,colorMask:15,sampleCount:1})}canvasFlipTexture(){let e=Math.max(1,this.canvas.width),t=Math.max(1,this.canvas.height),n=this.rhi.caps.swapchainFormat,r=this.canvasFlip;return r&&r.width===e&&r.height===t&&r.format===n?r:(r&&(this.releaseTargets(r),r.destroy()),this.canvasFlip=this.scope.createTexture({label:`engine2d 画布中间纹理`,width:e,height:t,format:n,usage:B.RENDER_TARGET|B.SAMPLED|B.COPY_SRC}),this.canvasFlip)}passTarget(e,t){let n;if(e.target===`canvas`){if(!t)throw Error(`[engine2d] 画到画布必须在帧内`);n=this.canvasFlipTexture()}else n=e.color;let r=this.targets.get(n);return r||this.targets.set(n,r={}),e.samples>1?this.msaaTarget(n,r,e.samples,e.stencil):e.stencil?(r.stencil||(r.depth=this.scope.createTexture({label:`${n.label} 模板`,width:n.width,height:n.height,format:jr,usage:B.RENDER_TARGET}),r.stencil=this.scope.createRenderTarget({label:`${n.label} 目标+模板`,colors:[n],depth:r.depth})),r.stencil):r.plain??=this.scope.createRenderTarget({label:`${n.label} 目标`,colors:[n]})}msaaTarget(e,t,n,r){return t.msaaColor??=this.scope.createTexture({label:`${e.label} MSAA×${n}`,width:e.width,height:e.height,format:e.format,usage:B.RENDER_TARGET,sampleCount:n}),r?(t.msaaStencil||=(t.msaaDepth=this.scope.createTexture({label:`${e.label} 模板 MSAA×${n}`,width:e.width,height:e.height,format:jr,usage:B.RENDER_TARGET,sampleCount:n}),this.scope.createRenderTarget({label:`${e.label} 目标+模板 MSAA×${n}`,colors:[t.msaaColor],depth:t.msaaDepth,resolveTargets:[e]})),t.msaaStencil):t.msaaPlain??=this.scope.createRenderTarget({label:`${e.label} 目标 MSAA×${n}`,colors:[t.msaaColor],resolveTargets:[e]})}releaseTargets(e){let t=this.targets.get(e);t&&(t.plain?.destroy(),t.stencil?.destroy(),t.depth?.destroy(),t.msaaPlain?.destroy(),t.msaaStencil?.destroy(),t.msaaDepth?.destroy(),t.msaaColor?.destroy(),this.targets.delete(e))}prewarmPipelines(e){this.destroyed||(this.prewarmSpecs.push(...e),this.buildPrewarm(e))}buildPrewarm(e){if(this.destroyed||!e.length)return;let t=this.rhi.caps.swapchainFormat,n=[{format:t,samples:Pr(this.antialias,t)}];(t!==`bgra8unorm`||n[0].samples!==1)&&n.push({format:`bgra8unorm`,samples:1});for(let t of e)try{let e=this.pipelines.layout(t.geometry,t.program),r=t.texture??I.WHITE;for(let i of t.blendModes){let a=qr(i,r.source),o=t.colorFormats?.map(e=>({format:e,samples:t.sampleCount??1}))??n;for(let n of o)for(let r of[null,jr])this.pipelines.get({program:t.program,layout:e,topology:t.geometry.topology,blend:a,colorFormat:n.format,depthFormat:r,stencil:`disabled`,colorMask:15,sampleCount:n.samples})}}catch(e){console.warn(`[engine2d] 预建管线失败(${t.program.name??`program-${t.program.uid}`}):`,e)}}gpuTextureOf(e){return this.textures.get(e)}pipelinesReady(e=1e4){return this.pipelines.whenAllReady(e)}generateTexture(e){let t=e instanceof Ye?{target:e}:e,n=t.resolution||this.resolution,r=t.antialias||this.antialias,i=t.target,a;if(t.clearColor){let e=t.clearColor;a=Array.isArray(e)&&e.length===4?e:ne.shared.setValue(t.clearColor).toArray()}else a=[0,0,0,0];let o=t.frame?t.frame.clone():nt(i,new L).rectangle.clone();o.width=Math.max(o.width,1/n)|0,o.height=Math.max(o.height,1/n)|0;let s=ye.create({...t.textureSourceOptions??{},width:o.width,height:o.height,resolution:n,antialias:r}),c=new S().translate(-o.x,-o.y);return this.render({container:i,transform:c,target:s,clearColor:a}),s.source.updateMipmaps(),s}readTextureRaw(e){return this.rhi.readTexture(this.textures.get(e))}async readPixels(e,t){let n=this.textures.get(e),r=await this.rhi.readTexture(n),i=t?Math.round(t.x*e._resolution):0,a=t?Math.round(t.y*e._resolution):0,o=t?Math.round(t.width*e._resolution):r.width,s=t?Math.round(t.height*e._resolution):r.height,c=new Uint8ClampedArray(o*s*4),l=r.format===`bgra8unorm`;for(let e=0;e<s;e++)for(let t=0;t<o;t++){let n=((e+a)*r.width+(t+i))*4,s=(e*o+t)*4;c[s]=r.data[n+(l?2:0)],c[s+1]=r.data[n+1],c[s+2]=r.data[n+(l?0:2)],c[s+3]=r.data[n+3]}return{pixels:c,width:o,height:s}}async readCanvasPixels(){let e=this.canvasFlip;if(this.destroyed||!e)return null;let t=await this.rhi.readTexture(e),{width:n,height:r}=t,i=new Uint8ClampedArray(n*r*4),a=t.format===`bgra8unorm`;for(let e=0;e<r;e++){let o=(r-1-e)*n*4,s=e*n*4;for(let e=0;e<n*4;e+=4)i[s+e]=t.data[o+e+(a?2:0)],i[s+e+1]=t.data[o+e+1],i[s+e+2]=t.data[o+e+(a?0:2)],i[s+e+3]=t.data[o+e+3]}return{pixels:i,width:n,height:r}}destroy(e=!1){if(!this.destroyed){this.destroyed=!0,this.offRestored(),this.prewarmSpecs.length=0,this.events?.destroy();for(let e of[...this.targets.keys()])this.releaseTargets(e);this.gc.destroy(),this.pipelines.destroy(),this.buffers.destroy(),this.textures.destroy(),this.scope.destroy(),this.ownsDevice&&this.rhi.destroy(),(typeof e==`boolean`?e:e.removeView)&&this.canvas.parentNode?.removeChild(this.canvas)}}get swapchainFormat(){return this.rhi.caps.swapchainFormat}};function Ri(e){if(e==null)return[0,0,0,0];if(Array.isArray(e)&&e.length===4)return[e[0],e[1],e[2],e[3]];let t=ne.shared.setValue(e).toArray();return[t[0],t[1],t[2],t[3]]}var zi={png:`image/png`,jpg:`image/jpeg`,webp:`image/webp`},Bi={format:`png`,quality:1};function Vi(e){let t=t=>{if(t instanceof I)return{texture:t,owned:!1};if(t instanceof Ye)return{texture:e.generateTexture(t),owned:!0};let n=t.target;return n instanceof I?{texture:n,frame:t.frame,owned:!1}:{texture:e.generateTexture({target:n,frame:t.frame,resolution:t.resolution,clearColor:t.clearColor,antialias:t.antialias}),owned:!0}},n=async n=>{let{texture:r,frame:i,owned:a}=t(n);try{return await e.readPixels(r.source,i??r.frame)}finally{a&&r.destroy(!0)}},r=async e=>{let{pixels:t,width:r,height:i}=await n(e),a=document.createElement(`canvas`);a.width=r,a.height=i;let o=a.getContext(`2d`),s=o.createImageData(r,i);return s.data.set(t),o.putImageData(s,0,0),a},i=async e=>{let t=await r(e),n=!(e instanceof Ye)&&!(e instanceof I)?e:void 0,i=n?.format??Bi.format,a=n?.quality??Bi.quality;return t.toDataURL(zi[i],a)};return{pixels:n,canvas:r,base64:i,image:async e=>{let t=new Image;return t.src=await i(e),await t.decode(),t},texture:t=>e.generateTexture(t)}}var Hi=new class{constructor(){this.interactionFrequency=10,this._deltaTime=0,this._didMove=!1,this._tickerAdded=!1,this._pauseUpdate=!0}init(e){this.removeTickerListener(),this.events=e,this.interactionFrequency=10,this._deltaTime=0,this._didMove=!1,this._tickerAdded=!1,this._pauseUpdate=!0}get pauseUpdate(){return this._pauseUpdate}set pauseUpdate(e){this._pauseUpdate=e}addTickerListener(){this._tickerAdded||!this.domElement||(ce.system.add(this._tickerUpdate,this,oe.INTERACTION),this._tickerAdded=!0)}removeTickerListener(){this._tickerAdded&&=(ce.system.remove(this._tickerUpdate,this),!1)}pointerMoved(){this._didMove=!0}_update(){if(!this.domElement||this._pauseUpdate)return;if(this._didMove){this._didMove=!1;return}let e=this.events._rootPointerEvent;this.events.supportsTouchEvents&&e.pointerType===`touch`||globalThis.document.dispatchEvent(this.events.supportsPointerEvents?new PointerEvent(`pointermove`,{clientX:e.clientX,clientY:e.clientY,pointerType:e.pointerType,pointerId:e.pointerId}):new MouseEvent(`mousemove`,{clientX:e.clientX,clientY:e.clientY}))}_tickerUpdate(e){this._deltaTime+=e.deltaTime,!(this._deltaTime<this.interactionFrequency)&&(this._deltaTime=0,this._update())}destroy(){this.removeTickerListener(),this.events=null,this.domElement=null,this._deltaTime=0,this._didMove=!1,this._tickerAdded=!1,this._pauseUpdate=!0}},Ui=class e{get layerX(){return this.layer.x}get layerY(){return this.layer.y}get pageX(){return this.page.x}get pageY(){return this.page.y}constructor(t){this.bubbles=!0,this.cancelBubble=!0,this.cancelable=!1,this.composed=!1,this.defaultPrevented=!1,this.eventPhase=e.prototype.NONE,this.propagationStopped=!1,this.propagationImmediatelyStopped=!1,this.layer=new v,this.page=new v,this.NONE=0,this.CAPTURING_PHASE=1,this.AT_TARGET=2,this.BUBBLING_PHASE=3,this.manager=t}get data(){return this}composedPath(){return this.manager&&(!this.path||this.path[this.path.length-1]!==this.target)&&(this.path=this.target?this.manager.propagationPath(this.target):[]),this.path}initEvent(e,t,n){throw Error(`initEvent() is a legacy DOM API. It is not implemented in the Federated Events API.`)}initUIEvent(e,t,n,r,i){throw Error(`initUIEvent() is a legacy DOM API. It is not implemented in the Federated Events API.`)}preventDefault(){this.nativeEvent instanceof Event&&this.nativeEvent.cancelable&&this.nativeEvent.preventDefault(),this.defaultPrevented=!0}stopImmediatePropagation(){this.propagationImmediatelyStopped=!0}stopPropagation(){this.propagationStopped=!0}},Wi=class extends Ui{constructor(...e){super(...e),this.client=new v,this.movement=new v,this.offset=new v,this.global=new v,this.screen=new v}get clientX(){return this.client.x}get clientY(){return this.client.y}get x(){return this.clientX}get y(){return this.clientY}get movementX(){return this.movement.x}get movementY(){return this.movement.y}get offsetX(){return this.offset.x}get offsetY(){return this.offset.y}get globalX(){return this.global.x}get globalY(){return this.global.y}get screenX(){return this.screen.x}get screenY(){return this.screen.y}getLocalPosition(e,t,n){return e.worldTransform.applyInverse(n||this.global,t)}getModifierState(e){return`getModifierState`in this.nativeEvent&&this.nativeEvent.getModifierState(e)}initMouseEvent(e,t,n,r,i,a,o,s,c,l,u,d,f,p,m){throw Error(`Method not implemented.`)}},Gi=class extends Wi{constructor(...e){super(...e),this.width=0,this.height=0,this.isPrimary=!1}getCoalescedEvents(){return this.type===`pointermove`||this.type===`mousemove`||this.type===`touchmove`?[this]:[]}getPredictedEvents(){throw Error(`getPredictedEvents is not supported!`)}},Ki=class extends Wi{constructor(...e){super(...e),this.DOM_DELTA_PIXEL=0,this.DOM_DELTA_LINE=1,this.DOM_DELTA_PAGE=2}static{this.DOM_DELTA_PIXEL=0}static{this.DOM_DELTA_LINE=1}static{this.DOM_DELTA_PAGE=2}},qi=2048,Ji=new v,Yi=new v;function Xi(e,t){let n=e._events;return n?n.get(t):void 0}var Zi=0,Qi=500;function $i(e){Zi!==Qi&&(Zi++,Zi===Qi?console.warn(`engine2d Warning: too many warnings, no more warnings will be reported to the console.`):console.warn(`engine2d Warning: `,e))}var ea=class{constructor(e){this.dispatch=new _,this.moveOnAll=!1,this.enableGlobalMoveEvents=!0,this.mappingState={trackingData:{}},this.eventPool=new Map,this._allInteractiveElements=[],this._hitElements=[],this._isPointerMoveEvent=!1,this.rootTarget=e,this.hitPruneFn=this.hitPruneFn.bind(this),this.hitTestFn=this.hitTestFn.bind(this),this.mapPointerDown=this.mapPointerDown.bind(this),this.mapPointerMove=this.mapPointerMove.bind(this),this.mapPointerOut=this.mapPointerOut.bind(this),this.mapPointerOver=this.mapPointerOver.bind(this),this.mapPointerUp=this.mapPointerUp.bind(this),this.mapPointerUpOutside=this.mapPointerUpOutside.bind(this),this.mapWheel=this.mapWheel.bind(this),this.mappingTable={},this.addEventMapping(`pointerdown`,this.mapPointerDown),this.addEventMapping(`pointermove`,this.mapPointerMove),this.addEventMapping(`pointerout`,this.mapPointerOut),this.addEventMapping(`pointerleave`,this.mapPointerOut),this.addEventMapping(`pointerover`,this.mapPointerOver),this.addEventMapping(`pointerup`,this.mapPointerUp),this.addEventMapping(`pointerupoutside`,this.mapPointerUpOutside),this.addEventMapping(`wheel`,this.mapWheel)}addEventMapping(e,t){this.mappingTable[e]||(this.mappingTable[e]=[]),this.mappingTable[e].push({fn:t,priority:0}),this.mappingTable[e].sort((e,t)=>e.priority-t.priority)}dispatchEvent(e,t){e.propagationStopped=!1,e.propagationImmediatelyStopped=!1,this.propagate(e,t),this.dispatch.emit(t||e.type,e)}mapEvent(e){if(!this.rootTarget)return;let t=this.mappingTable[e.type];if(t)for(let n=0,r=t.length;n<r;n++)t[n].fn(e);else $i(`[EventBoundary]: Event mapping not defined for ${e.type}`)}hitTest(e,t){Hi.pauseUpdate=!0;let n=this._isPointerMoveEvent&&this.enableGlobalMoveEvents?`hitTestMoveRecursive`:`hitTestRecursive`,r=this[n](this.rootTarget,this.rootTarget.eventMode,Ji.set(e,t),this.hitTestFn,this.hitPruneFn);return r&&r[0]}propagate(e,t){if(!e.target)return;let n=e.composedPath();e.eventPhase=e.CAPTURING_PHASE;for(let r=0,i=n.length-1;r<i;r++)if(e.currentTarget=n[r],this.notifyTarget(e,t),e.propagationStopped||e.propagationImmediatelyStopped)return;if(e.eventPhase=e.AT_TARGET,e.currentTarget=e.target,this.notifyTarget(e,t),!(e.propagationStopped||e.propagationImmediatelyStopped)){e.eventPhase=e.BUBBLING_PHASE;for(let r=n.length-2;r>=0;r--)if(e.currentTarget=n[r],this.notifyTarget(e,t),e.propagationStopped||e.propagationImmediatelyStopped)return}}all(e,t,n=this._allInteractiveElements){if(n.length===0)return;e.eventPhase=e.BUBBLING_PHASE;let r=Array.isArray(t)?t:[t];for(let t=n.length-1;t>=0;t--)r.forEach(r=>{e.currentTarget=n[t],this.notifyTarget(e,r)})}propagationPath(e){let t=[e];for(let n=0;n<qi&&e!==this.rootTarget&&e.parent;n++){if(!e.parent)throw Error(`Cannot find propagation path to disconnected target`);t.push(e.parent),e=e.parent}return t.reverse(),t}hitTestMoveRecursive(e,t,n,r,i,a=!1){let o=!1;if(this._interactivePrune(e))return null;if((e.eventMode===`dynamic`||t===`dynamic`)&&(Hi.pauseUpdate=!1),e.interactiveChildren&&e.children){let s=e.children;for(let c=s.length-1;c>=0;c--){let l=s[c],u=this.hitTestMoveRecursive(l,this._isInteractive(t)?t:l.eventMode,n,r,i,a||i(e,n));if(u){if(u.length>0&&!u[u.length-1].parent)continue;let t=e.isInteractive();(u.length>0||t)&&(t&&this._allInteractiveElements.push(e),u.push(e)),this._hitElements.length===0&&(this._hitElements=u),o=!0}}}let s=this._isInteractive(t),c=e.isInteractive();return c&&c&&this._allInteractiveElements.push(e),a||this._hitElements.length>0?null:o?this._hitElements:s&&!i(e,n)&&r(e,n)?c?[e]:[]:null}hitTestRecursive(e,t,n,r,i){if(this._interactivePrune(e)||i(e,n))return null;if((e.eventMode===`dynamic`||t===`dynamic`)&&(Hi.pauseUpdate=!1),e.interactiveChildren&&e.children){let a=e.children,o=n;for(let n=a.length-1;n>=0;n--){let s=a[n],c=this.hitTestRecursive(s,this._isInteractive(t)?t:s.eventMode,o,r,i);if(c){if(c.length>0&&!c[c.length-1].parent)continue;let t=e.isInteractive();return(c.length>0||t)&&c.push(e),c}}}let a=this._isInteractive(t),o=e.isInteractive();return a&&r(e,n)?o?[e]:[]:null}_isInteractive(e){return e===`static`||e===`dynamic`}_interactivePrune(e){return!e||!e.activeSelf||!e.visible||!e.renderable||!e.measurable||e.eventMode===`none`||e.eventMode===`passive`&&!e.interactiveChildren}hitPruneFn(e,t){if(e.hitArea&&(e.worldTransform.applyInverse(t,Yi),!e.hitArea.contains(Yi.x,Yi.y)))return!0;if(e.effects&&e.effects.length)for(let n=0;n<e.effects.length;n++){let r=e.effects[n];if(r.containsPoint&&!r.containsPoint(t,this.hitTestFn))return!0}return!1}hitTestFn(e,t){return e.hitArea?!0:e?.containsPoint?(e.worldTransform.applyInverse(t,Yi),e.containsPoint(Yi)):!1}notifyTarget(e,t){if(!e.currentTarget.isInteractive())return;t??=e.type;let n=`on${t}`;e.currentTarget[n]?.(e);let r=e.eventPhase===e.CAPTURING_PHASE||e.eventPhase===e.AT_TARGET?`${t}capture`:t;this._notifyListeners(e,r),e.eventPhase===e.AT_TARGET&&this._notifyListeners(e,t)}mapPointerDown(e){if(!(e instanceof Gi)){$i(`EventBoundary cannot map a non-pointer event as a pointer event`);return}let t=this.createPointerEvent(e);if(this.dispatchEvent(t,`pointerdown`),t.pointerType===`touch`)this.dispatchEvent(t,`touchstart`);else if(t.pointerType===`mouse`||t.pointerType===`pen`){let e=t.button===2;this.dispatchEvent(t,e?`rightdown`:`mousedown`)}let n=this.trackingData(e.pointerId);n.pressTargetsByButton[e.button]=t.composedPath(),this.freeEvent(t)}mapPointerMove(e){if(!(e instanceof Gi)){$i(`EventBoundary cannot map a non-pointer event as a pointer event`);return}this._allInteractiveElements.length=0,this._hitElements.length=0,this._isPointerMoveEvent=!0;let t=this.createPointerEvent(e);this._isPointerMoveEvent=!1;let n=t.pointerType===`mouse`||t.pointerType===`pen`,r=this.trackingData(e.pointerId),i=this.findMountedTarget(r.overTargets);if(r.overTargets?.length>0&&i!==t.target){let r=e.type===`mousemove`?`mouseout`:`pointerout`,a=this.createPointerEvent(e,r,i);if(this.dispatchEvent(a,`pointerout`),n&&this.dispatchEvent(a,`mouseout`),!t.composedPath().includes(i)){let r=this.createPointerEvent(e,`pointerleave`,i);for(r.eventPhase=r.AT_TARGET;r.target&&!t.composedPath().includes(r.target);)r.currentTarget=r.target,this.notifyTarget(r),n&&this.notifyTarget(r,`mouseleave`),r.target=r.target.parent;this.freeEvent(r)}this.freeEvent(a)}if(i!==t.target){let r=e.type===`mousemove`?`mouseover`:`pointerover`,a=this.clonePointerEvent(t,r);this.dispatchEvent(a,`pointerover`),n&&this.dispatchEvent(a,`mouseover`);let o=i?.parent;for(;o&&o!==this.rootTarget.parent&&o!==t.target;)o=o.parent;if(!o||o===this.rootTarget.parent){let e=this.clonePointerEvent(t,`pointerenter`);for(e.eventPhase=e.AT_TARGET;e.target&&e.target!==i&&e.target!==this.rootTarget.parent;)e.currentTarget=e.target,this.notifyTarget(e),n&&this.notifyTarget(e,`mouseenter`),e.target=e.target.parent;this.freeEvent(e)}this.freeEvent(a)}let a=[],o=this.enableGlobalMoveEvents??!0;this.moveOnAll?a.push(`pointermove`):this.dispatchEvent(t,`pointermove`),o&&a.push(`globalpointermove`),t.pointerType===`touch`&&(this.moveOnAll?a.splice(1,0,`touchmove`):this.dispatchEvent(t,`touchmove`),o&&a.push(`globaltouchmove`)),n&&(this.moveOnAll?a.splice(1,0,`mousemove`):this.dispatchEvent(t,`mousemove`),o&&a.push(`globalmousemove`),this.cursor=t.target?.cursor),a.length>0&&this.all(t,a),this._allInteractiveElements.length=0,this._hitElements.length=0,r.overTargets=t.composedPath(),this.freeEvent(t)}mapPointerOver(e){if(!(e instanceof Gi)){$i(`EventBoundary cannot map a non-pointer event as a pointer event`);return}let t=this.trackingData(e.pointerId),n=this.createPointerEvent(e),r=n.pointerType===`mouse`||n.pointerType===`pen`;this.dispatchEvent(n,`pointerover`),r&&this.dispatchEvent(n,`mouseover`),n.pointerType===`mouse`&&(this.cursor=n.target?.cursor);let i=this.clonePointerEvent(n,`pointerenter`);for(i.eventPhase=i.AT_TARGET;i.target&&i.target!==this.rootTarget.parent;)i.currentTarget=i.target,this.notifyTarget(i),r&&this.notifyTarget(i,`mouseenter`),i.target=i.target.parent;t.overTargets=n.composedPath(),this.freeEvent(n),this.freeEvent(i)}mapPointerOut(e){if(!(e instanceof Gi)){$i(`EventBoundary cannot map a non-pointer event as a pointer event`);return}let t=this.trackingData(e.pointerId);if(t.overTargets){let n=e.pointerType===`mouse`||e.pointerType===`pen`,r=this.findMountedTarget(t.overTargets),i=this.createPointerEvent(e,`pointerout`,r);this.dispatchEvent(i),n&&this.dispatchEvent(i,`mouseout`);let a=this.createPointerEvent(e,`pointerleave`,r);for(a.eventPhase=a.AT_TARGET;a.target&&a.target!==this.rootTarget.parent;)a.currentTarget=a.target,this.notifyTarget(a),n&&this.notifyTarget(a,`mouseleave`),a.target=a.target.parent;t.overTargets=null,this.freeEvent(i),this.freeEvent(a)}this.cursor=null}mapPointerUp(e){if(!(e instanceof Gi)){$i(`EventBoundary cannot map a non-pointer event as a pointer event`);return}let t=performance.now(),n=this.createPointerEvent(e);if(this.dispatchEvent(n,`pointerup`),n.pointerType===`touch`)this.dispatchEvent(n,`touchend`);else if(n.pointerType===`mouse`||n.pointerType===`pen`){let e=n.button===2;this.dispatchEvent(n,e?`rightup`:`mouseup`)}let r=this.trackingData(e.pointerId),i=this.findMountedTarget(r.pressTargetsByButton[e.button]),a=i;if(i&&!n.composedPath().includes(i)){let t=i;for(;t&&!n.composedPath().includes(t);){if(n.currentTarget=t,this.notifyTarget(n,`pointerupoutside`),n.pointerType===`touch`)this.notifyTarget(n,`touchendoutside`);else if(n.pointerType===`mouse`||n.pointerType===`pen`){let e=n.button===2;this.notifyTarget(n,e?`rightupoutside`:`mouseupoutside`)}t=t.parent}delete r.pressTargetsByButton[e.button],a=t}if(a){let i=this.clonePointerEvent(n,`click`);i.target=a,i.path=null,r.clicksByButton[e.button]||(r.clicksByButton[e.button]={clickCount:0,target:i.target,timeStamp:t});let o=r.clicksByButton[e.button];if(o.target===i.target&&t-o.timeStamp<200?++o.clickCount:o.clickCount=1,o.target=i.target,o.timeStamp=t,i.detail=o.clickCount,i.pointerType===`mouse`){let e=i.button===2;this.dispatchEvent(i,e?`rightclick`:`click`)}else i.pointerType===`touch`&&this.dispatchEvent(i,`tap`);this.dispatchEvent(i,`pointertap`),this.freeEvent(i)}this.freeEvent(n)}mapPointerUpOutside(e){if(!(e instanceof Gi)){$i(`EventBoundary cannot map a non-pointer event as a pointer event`);return}let t=this.trackingData(e.pointerId),n=this.findMountedTarget(t.pressTargetsByButton[e.button]),r=this.createPointerEvent(e);if(n){let i=n;for(;i;)r.currentTarget=i,this.notifyTarget(r,`pointerupoutside`),r.pointerType===`touch`?this.notifyTarget(r,`touchendoutside`):(r.pointerType===`mouse`||r.pointerType===`pen`)&&this.notifyTarget(r,r.button===2?`rightupoutside`:`mouseupoutside`),i=i.parent;delete t.pressTargetsByButton[e.button]}this.freeEvent(r)}mapWheel(e){if(!(e instanceof Ki)){$i(`EventBoundary cannot map a non-wheel event as a wheel event`);return}let t=this.createWheelEvent(e);this.dispatchEvent(t),this.freeEvent(t)}findMountedTarget(e){if(!e)return null;let t=e[0];for(let n=1;n<e.length&&e[n].parent===t;n++)t=e[n];return t}createPointerEvent(e,t,n){let r=this.allocateEvent(Gi);return this.copyPointerData(e,r),this.copyMouseData(e,r),this.copyData(e,r),r.nativeEvent=e.nativeEvent,r.originalEvent=e,r.target=n??this.hitTest(r.global.x,r.global.y)??this._hitElements[0],typeof t==`string`&&(r.type=t),r}createWheelEvent(e){let t=this.allocateEvent(Ki);return this.copyWheelData(e,t),this.copyMouseData(e,t),this.copyData(e,t),t.nativeEvent=e.nativeEvent,t.originalEvent=e,t.target=this.hitTest(t.global.x,t.global.y),t}clonePointerEvent(e,t){let n=this.allocateEvent(Gi);return n.nativeEvent=e.nativeEvent,n.originalEvent=e.originalEvent,this.copyPointerData(e,n),this.copyMouseData(e,n),this.copyData(e,n),n.target=e.target,n.path=e.composedPath().slice(),n.type=t??n.type,n}copyWheelData(e,t){t.deltaMode=e.deltaMode,t.deltaX=e.deltaX,t.deltaY=e.deltaY,t.deltaZ=e.deltaZ}copyPointerData(e,t){e instanceof Gi&&t instanceof Gi&&(t.pointerId=e.pointerId,t.width=e.width,t.height=e.height,t.isPrimary=e.isPrimary,t.pointerType=e.pointerType,t.pressure=e.pressure,t.tangentialPressure=e.tangentialPressure,t.tiltX=e.tiltX,t.tiltY=e.tiltY,t.twist=e.twist)}copyMouseData(e,t){e instanceof Wi&&t instanceof Wi&&(t.altKey=e.altKey,t.button=e.button,t.buttons=e.buttons,t.client.copyFrom(e.client),t.ctrlKey=e.ctrlKey,t.metaKey=e.metaKey,t.movement.copyFrom(e.movement),t.screen.copyFrom(e.screen),t.shiftKey=e.shiftKey,t.global.copyFrom(e.global))}copyData(e,t){t.isTrusted=e.isTrusted,t.srcElement=e.srcElement,t.timeStamp=performance.now(),t.type=e.type,t.detail=e.detail,t.view=e.view,t.which=e.which,t.layer.copyFrom(e.layer),t.page.copyFrom(e.page)}trackingData(e){return this.mappingState.trackingData[e]||(this.mappingState.trackingData[e]={pressTargetsByButton:{},clicksByButton:{},overTargets:null}),this.mappingState.trackingData[e]}allocateEvent(e){this.eventPool.has(e)||this.eventPool.set(e,[]);let t=this.eventPool.get(e).pop()||new e(this);return t.eventPhase=t.NONE,t.currentTarget=null,t.defaultPrevented=!1,t.path=null,t.target=null,t}freeEvent(e){if(e.manager!==this)throw Error(`It is illegal to free an event not managed by this EventBoundary!`);let t=e.constructor;this.eventPool.has(t)||this.eventPool.set(t,[]),this.eventPool.get(t).push(e)}_notifyListeners(e,t){let n=Xi(e.currentTarget,t);if(!(!n||n.length===0))if(n.length===1){let r=n[0];r.once&&e.currentTarget.removeListener(t,r.fn,void 0,!0),r.fn.call(r.ctx,e)}else for(let r=0,i=n.length;r<i&&!e.propagationImmediatelyStopped;r++)n[r].once&&e.currentTarget.removeListener(t,n[r].fn,void 0,!0),n[r].fn.call(n[r].ctx,e)}},ta=1,na={touchstart:`pointerdown`,touchend:`pointerup`,touchendoutside:`pointerupoutside`,touchmove:`pointermove`,touchcancel:`pointercancel`},ra=class e{static{this.defaultEventFeatures={move:!0,globalMove:!0,click:!0,wheel:!0}}static get defaultEventMode(){return this._defaultEventMode}constructor(t){this.supportsTouchEvents=`ontouchstart`in globalThis,this.supportsPointerEvents=!!globalThis.PointerEvent,this.domElement=null,this.resolution=1,this.renderer=t,this.rootBoundary=new ea(null),Hi.init(this),this.autoPreventDefault=!0,this._eventsAdded=!1,this._rootPointerEvent=new Gi(null),this._rootWheelEvent=new Ki(null),this.cursorStyles={default:`inherit`,pointer:`pointer`},this.features=new Proxy({...e.defaultEventFeatures},{set:(e,t,n)=>(t===`globalMove`&&(this.rootBoundary.enableGlobalMoveEvents=n),e[t]=n,!0)}),this._onPointerDown=this._onPointerDown.bind(this),this._onPointerMove=this._onPointerMove.bind(this),this._onPointerUp=this._onPointerUp.bind(this),this._onPointerOverOut=this._onPointerOverOut.bind(this),this.onWheel=this.onWheel.bind(this)}init(t={}){let{canvas:n,resolution:r}=this.renderer;this.setTargetElement(n),this.resolution=r,e._defaultEventMode=t.eventMode??`passive`,Object.assign(this.features,t.eventFeatures??{}),this.rootBoundary.enableGlobalMoveEvents=this.features.globalMove}resolutionChange(e){this.resolution=e}destroy(){Hi.destroy(),this.setTargetElement(null),this.renderer=null,this._currentCursor=null}setCursor(e){e||=`default`;let t=!0;if(globalThis.OffscreenCanvas&&this.domElement instanceof OffscreenCanvas&&(t=!1),this._currentCursor===e)return;this._currentCursor=e;let n=this.cursorStyles[e];if(n)switch(typeof n){case`string`:t&&(this.domElement.style.cursor=n);break;case`function`:n(e);break;case`object`:t&&Object.assign(this.domElement.style,n);break}else t&&typeof e==`string`&&!Object.prototype.hasOwnProperty.call(this.cursorStyles,e)&&(this.domElement.style.cursor=e)}get pointer(){return this._rootPointerEvent}_onPointerDown(e){if(!this.features.click)return;this.rootBoundary.rootTarget=this.renderer.lastObjectRendered;let t=this._normalizeToPointerData(e);this.autoPreventDefault&&t[0].isNormalized&&(e.cancelable||!(`cancelable`in e))&&e.preventDefault();for(let e=0,n=t.length;e<n;e++){let n=t[e],r=this._bootstrapEvent(this._rootPointerEvent,n);this.rootBoundary.mapEvent(r)}this.setCursor(this.rootBoundary.cursor)}_onPointerMove(e){if(!this.features.move)return;this.rootBoundary.rootTarget=this.renderer.lastObjectRendered,Hi.pointerMoved();let t=this._normalizeToPointerData(e);for(let e=0,n=t.length;e<n;e++){let n=this._bootstrapEvent(this._rootPointerEvent,t[e]);this.rootBoundary.mapEvent(n)}this.setCursor(this.rootBoundary.cursor)}_onPointerUp(e){if(!this.features.click)return;this.rootBoundary.rootTarget=this.renderer.lastObjectRendered;let t=e.target;e.composedPath&&e.composedPath().length>0&&(t=e.composedPath()[0]);let n=t===this.domElement?``:`outside`,r=this._normalizeToPointerData(e);for(let e=0,t=r.length;e<t;e++){let t=this._bootstrapEvent(this._rootPointerEvent,r[e]);t.type+=n,this.rootBoundary.mapEvent(t)}this.setCursor(this.rootBoundary.cursor)}_onPointerOverOut(e){if(!this.features.click)return;this.rootBoundary.rootTarget=this.renderer.lastObjectRendered;let t=this._normalizeToPointerData(e);for(let e=0,n=t.length;e<n;e++){let n=this._bootstrapEvent(this._rootPointerEvent,t[e]);this.rootBoundary.mapEvent(n)}this.setCursor(this.rootBoundary.cursor)}onWheel(e){if(!this.features.wheel)return;let t=this.normalizeWheelEvent(e);this.rootBoundary.rootTarget=this.renderer.lastObjectRendered,this.rootBoundary.mapEvent(t)}setTargetElement(e){this._removeEvents(),this.domElement=e,Hi.domElement=e,this._addEvents()}_addEvents(){if(this._eventsAdded||!this.domElement)return;Hi.addTickerListener();let e=this.domElement.style;e&&(globalThis.navigator.msPointerEnabled?(e.msContentZooming=`none`,e.msTouchAction=`none`):this.supportsPointerEvents&&(e.touchAction=`none`)),this.supportsPointerEvents?(globalThis.document.addEventListener(`pointermove`,this._onPointerMove,!0),this.domElement.addEventListener(`pointerdown`,this._onPointerDown,!0),this.domElement.addEventListener(`pointerleave`,this._onPointerOverOut,!0),this.domElement.addEventListener(`pointerover`,this._onPointerOverOut,!0),globalThis.addEventListener(`pointerup`,this._onPointerUp,!0)):(globalThis.document.addEventListener(`mousemove`,this._onPointerMove,!0),this.domElement.addEventListener(`mousedown`,this._onPointerDown,!0),this.domElement.addEventListener(`mouseout`,this._onPointerOverOut,!0),this.domElement.addEventListener(`mouseover`,this._onPointerOverOut,!0),globalThis.addEventListener(`mouseup`,this._onPointerUp,!0),this.supportsTouchEvents&&(this.domElement.addEventListener(`touchstart`,this._onPointerDown,!0),this.domElement.addEventListener(`touchend`,this._onPointerUp,!0),this.domElement.addEventListener(`touchmove`,this._onPointerMove,!0))),this.domElement.addEventListener(`wheel`,this.onWheel,{passive:!0,capture:!0}),this._eventsAdded=!0}_removeEvents(){if(!this._eventsAdded||!this.domElement)return;Hi.removeTickerListener();let e=this.domElement.style;e&&(globalThis.navigator.msPointerEnabled?(e.msContentZooming=``,e.msTouchAction=``):this.supportsPointerEvents&&(e.touchAction=``)),this.supportsPointerEvents?(globalThis.document.removeEventListener(`pointermove`,this._onPointerMove,!0),this.domElement.removeEventListener(`pointerdown`,this._onPointerDown,!0),this.domElement.removeEventListener(`pointerleave`,this._onPointerOverOut,!0),this.domElement.removeEventListener(`pointerover`,this._onPointerOverOut,!0),globalThis.removeEventListener(`pointerup`,this._onPointerUp,!0)):(globalThis.document.removeEventListener(`mousemove`,this._onPointerMove,!0),this.domElement.removeEventListener(`mousedown`,this._onPointerDown,!0),this.domElement.removeEventListener(`mouseout`,this._onPointerOverOut,!0),this.domElement.removeEventListener(`mouseover`,this._onPointerOverOut,!0),globalThis.removeEventListener(`mouseup`,this._onPointerUp,!0),this.supportsTouchEvents&&(this.domElement.removeEventListener(`touchstart`,this._onPointerDown,!0),this.domElement.removeEventListener(`touchend`,this._onPointerUp,!0),this.domElement.removeEventListener(`touchmove`,this._onPointerMove,!0))),this.domElement.removeEventListener(`wheel`,this.onWheel,!0),this.domElement=null,this._eventsAdded=!1}mapPositionToPoint(e,t,n){let r=this.domElement.isConnected?this.domElement.getBoundingClientRect():{x:0,y:0,width:this.domElement.width,height:this.domElement.height,left:0,top:0},i=1/this.resolution;e.x=(t-r.left)*(this.domElement.width/r.width)*i,e.y=(n-r.top)*(this.domElement.height/r.height)*i}_normalizeToPointerData(e){let t=[];if(this.supportsTouchEvents&&e instanceof TouchEvent)for(let n=0,r=e.changedTouches.length;n<r;n++){let r=e.changedTouches[n];r.button===void 0&&(r.button=0),r.buttons===void 0&&(r.buttons=1),r.isPrimary===void 0&&(r.isPrimary=e.touches.length===1&&e.type===`touchstart`),r.width===void 0&&(r.width=r.radiusX||1),r.height===void 0&&(r.height=r.radiusY||1),r.tiltX===void 0&&(r.tiltX=0),r.tiltY===void 0&&(r.tiltY=0),r.pointerType===void 0&&(r.pointerType=`touch`),r.pointerId===void 0&&(r.pointerId=r.identifier||0),r.pressure===void 0&&(r.pressure=r.force||.5),r.twist===void 0&&(r.twist=0),r.tangentialPressure===void 0&&(r.tangentialPressure=0),r.layerX===void 0&&(r.layerX=r.offsetX=r.clientX),r.layerY===void 0&&(r.layerY=r.offsetY=r.clientY),r.isNormalized=!0,r.type=e.type,r.altKey??=e.altKey,r.ctrlKey??=e.ctrlKey,r.metaKey??=e.metaKey,r.shiftKey??=e.shiftKey,t.push(r)}else if(!globalThis.MouseEvent||e instanceof MouseEvent&&(!this.supportsPointerEvents||!(e instanceof globalThis.PointerEvent))){let n=e;n.isPrimary===void 0&&(n.isPrimary=!0),n.width===void 0&&(n.width=1),n.height===void 0&&(n.height=1),n.tiltX===void 0&&(n.tiltX=0),n.tiltY===void 0&&(n.tiltY=0),n.pointerType===void 0&&(n.pointerType=`mouse`),n.pointerId===void 0&&(n.pointerId=ta),n.pressure===void 0&&(n.pressure=.5),n.twist===void 0&&(n.twist=0),n.tangentialPressure===void 0&&(n.tangentialPressure=0),n.isNormalized=!0,t.push(n)}else t.push(e);return t}normalizeWheelEvent(e){let t=this._rootWheelEvent;return this._transferMouseData(t,e),t.deltaX=e.deltaX,t.deltaY=e.deltaY,t.deltaZ=e.deltaZ,t.deltaMode=e.deltaMode,this.mapPositionToPoint(t.screen,e.clientX,e.clientY),t.global.copyFrom(t.screen),t.offset.copyFrom(t.screen),t.nativeEvent=e,t.type=e.type,t}_bootstrapEvent(e,t){return e.originalEvent=null,e.nativeEvent=t,e.pointerId=t.pointerId,e.width=t.width,e.height=t.height,e.isPrimary=t.isPrimary,e.pointerType=t.pointerType,e.pressure=t.pressure,e.tangentialPressure=t.tangentialPressure,e.tiltX=t.tiltX,e.tiltY=t.tiltY,e.twist=t.twist,this._transferMouseData(e,t),this.mapPositionToPoint(e.screen,t.clientX,t.clientY),e.global.copyFrom(e.screen),e.offset.copyFrom(e.screen),e.isTrusted=t.isTrusted,e.type===`pointerleave`&&(e.type=`pointerout`),e.type.startsWith(`mouse`)&&(e.type=e.type.replace(`mouse`,`pointer`)),e.type.startsWith(`touch`)&&(e.type=na[e.type]||e.type),e}_transferMouseData(e,t){e.isTrusted=t.isTrusted,e.srcElement=t.srcElement,e.timeStamp=performance.now(),e.type=t.type,e.altKey=t.altKey,e.button=t.button,e.buttons=t.buttons,e.client.x=t.clientX,e.client.y=t.clientY,e.ctrlKey=t.ctrlKey,e.metaKey=t.metaKey,e.movement.x=t.movementX,e.movement.y=t.movementY,e.page.x=t.pageX,e.page.y=t.pageY,e.relatedTarget=null,e.shiftKey=t.shiftKey}};async function ia(e={}){let t=e.canvas??document.createElement(`canvas`),n=e.alphaMode??((e.backgroundAlpha??1)<1?`premultiplied`:`opaque`),r=!e.rhi;if(r){let n=e.resolution??1;t.width=Math.max(1,Math.round((e.width??800)*n)),t.height=Math.max(1,Math.round((e.height??600)*n))}let i=e.rhi??await Ln({canvas:t,alphaMode:n,useDevicePixels:!1,autoResize:!1}),a=new Li({width:800,height:600,...e,rhi:i,canvas:t});a.ownsDevice=r;let o=new ra(a);return o.init({eventMode:e.eventMode,eventFeatures:e.eventFeatures}),a.events=o,a}var aa={createCanvas:(e,t)=>{let n=document.createElement(`canvas`);return n.width=e,n.height=t,n},createImage:()=>new Image,getCanvasRenderingContext2D:()=>CanvasRenderingContext2D,getWebGLRenderingContext:()=>WebGLRenderingContext,getNavigator:()=>navigator,getBaseUrl:()=>document.baseURI??window.location.href,getFontFaceSet:()=>document.fonts,fetch:(e,t)=>fetch(e,t),parseXML:e=>new DOMParser().parseFromString(e,`text/xml`)},oa={get(){return aa},set(e){aa=e}};function sa(e){return e}var ca=class{static init(e){let t=sa(this);Object.defineProperty(this,`resizeTo`,{configurable:!0,set(e){let t=sa(this);globalThis.removeEventListener(`resize`,t.queueResize),t._resizeTo=e,e&&(globalThis.addEventListener(`resize`,t.queueResize),t.resize())},get(){return sa(this)._resizeTo}}),t.queueResize=()=>{t._resizeTo&&(t._cancelResize(),t._resizeId=requestAnimationFrame(()=>t.resize()))},t._cancelResize=()=>{t._resizeId&&=(cancelAnimationFrame(t._resizeId),null)},t.cancelResize=t._cancelResize,t.resize=()=>{if(!t._resizeTo)return;t._cancelResize();let e,n;if(t._resizeTo===globalThis.window)e=globalThis.innerWidth,n=globalThis.innerHeight;else{let{clientWidth:r,clientHeight:i}=t._resizeTo;e=r,n=i}this.renderer.resize(e,n),this.render()},t._resizeId=null,t._resizeTo=null,t.resizeTo=e.resizeTo||null}static destroy(){let e=sa(this);globalThis.removeEventListener(`resize`,e.queueResize),e._cancelResize(),e._cancelResize=null,e.cancelResize=null,e.queueResize=null,e.resizeTo=null,e.resize=null}};function la(e){return e}var ua=class{static init(e){let t=Object.assign({autoStart:!0,sharedTicker:!1},e),n=la(this);Object.defineProperty(this,`ticker`,{configurable:!0,set(e){let t=la(this);t._ticker&&t._ticker.remove(t.render,this),t._ticker=e,e&&e.add(t.render,this,oe.LOW)},get(){return la(this)._ticker}}),n.stop=()=>{n._ticker.stop()},n.start=()=>{n._ticker.start()},n._ticker=null,n.ticker=t.sharedTicker?ce.shared:new ce,t.autoStart&&n.start()}static destroy(){let e=la(this);if(e._ticker){let t=e._ticker;e.ticker=null,t.destroy()}}},da={width:800,height:600},fa=!1,pa=!1,ma=class e{static{this._plugins=[ca,ua]}constructor(...e){this.stage=new Ye,this._playerLoopTick=null,e[0]!==void 0&&!pa&&(pa=!0,console.warn(`[engine2d] Application 构造参数已弃用(同 Pixi v8),请用 await app.init(options)`))}async init(t){t={...t},this.stage||=new Ye,this.renderer=await ia(ha(t)),e._plugins.forEach(e=>{e.init.call(this,t)}),this.stage.isSceneRoot=!0,this._playerLoopTick=()=>we.shared.tick(this.ticker.deltaMS/1e3),this.ticker.add(this._playerLoopTick,null,oe.NORMAL)}render(){this.renderer.render({container:this.stage})}get canvas(){return this.renderer.canvas}get view(){return fa||(fa=!0,console.warn(`[engine2d] Application.view 已弃用(同 Pixi v8),请用 Application.canvas`)),this.renderer.canvas}get screen(){return this.renderer.screen}destroy(t=!1,n=!1){this._playerLoopTick&&=(this.ticker?.remove(this._playerLoopTick,null),null);let r=e._plugins.slice(0);r.reverse(),r.forEach(e=>{e.destroy.call(this)}),this.stage.destroy(n),this.stage=null,this.renderer.destroy(t),this.renderer=null}};function ha(e){let t={...da,...e};return t.width===void 0&&(t.width=da.width),t.height===void 0&&(t.height=da.height),t.canvas=e.canvas??e.view??oa.get().createCanvas(),t}var ga=new L,_a=new S,va=new E;(class e{static{this.shared=new e}cull(e,t,n=!0){this._cullRecursive(e,t,n)}_cullRecursive(e,t,n=!0){if(e.cullable&&e.measurable&&e.includeInBuild)if(e.cullArea){va.x=t.x,va.y=t.y,va.width=t.width,va.height=t.height;let r=n?at(e,_a):e.getGlobalTransform(_a,n);e.culled=!va.intersects(e.cullArea,r)}else{let r=n?ot(e,ga):it(e,n,ga);e.culled=r.x>=t.x+t.width||r.y>=t.y+t.height||r.x+r.width<=t.x||r.y+r.height<=t.y}else e.culled=!1;if(!(!e.cullableChildren||e.culled||!e.renderable||!e.measurable||!e.includeInBuild))for(let r=0;r<e.children.length;r++)this._cullRecursive(e.children[r],t,n)}});function ya(e){if(typeof e!=`string`)throw TypeError(`Path must be a string. Received ${JSON.stringify(e)}`)}function ba(e){return e.split(`?`)[0].split(`#`)[0]}function xa(e){return e.replace(/[.*+?^${}()|[\]\\]/g,`\\$&`)}function Sa(e,t,n){return e.replace(new RegExp(xa(t),`g`),n)}function Ca(e,t){let n=``,r=0,i=-1,a=0,o=-1;for(let s=0;s<=e.length;++s){if(s<e.length)o=e.charCodeAt(s);else if(o===47)break;else o=47;if(o===47){if(!(i===s-1||a===1))if(i!==s-1&&a===2){if(n.length<2||r!==2||n.charCodeAt(n.length-1)!==46||n.charCodeAt(n.length-2)!==46){if(n.length>2){let e=n.lastIndexOf(`/`);if(e!==n.length-1){e===-1?(n=``,r=0):(n=n.slice(0,e),r=n.length-1-n.lastIndexOf(`/`)),i=s,a=0;continue}}else if(n.length===2||n.length===1){n=``,r=0,i=s,a=0;continue}}t&&(n.length>0?n+=`/..`:n=`..`,r=2)}else n.length>0?n+=`/${e.slice(i+1,s)}`:n=e.slice(i+1,s),r=s-i-1;i=s,a=0}else o===46&&a!==-1?++a:a=-1}return n}var wa={toPosix(e){return Sa(e,`\\`,`/`)},isUrl(e){return/^https?:/.test(this.toPosix(e))},isDataUrl(e){return/^data:([a-z]+\/[a-z0-9-+.]+(;[a-z0-9-.!#$%*+.{}|~`]+=[a-z0-9-.!#$%*+.{}()_|~`]+)*)?(;base64)?,([a-z0-9!$&',()*+;=\-._~:@\/?%\s<>]*?)$/i.test(e)},isBlobUrl(e){return e.startsWith(`blob:`)},hasProtocol(e){return/^[^/:]+:/.test(this.toPosix(e))},getProtocol(e){ya(e),e=this.toPosix(e);let t=/^file:\/\/\//.exec(e);if(t)return t[0];let n=/^[^/:]+:\/{0,2}/.exec(e);return n?n[0]:``},toAbsolute(e,t,n){if(ya(e),this.isDataUrl(e)||this.isBlobUrl(e))return e;let r=ba(this.toPosix(t??oa.get().getBaseUrl())),i=ba(this.toPosix(n??this.rootname(r)));return e=this.toPosix(e),e.startsWith(`/`)?wa.join(i,e.slice(1)):this.isAbsolute(e)?e:this.join(r,e)},normalize(e){if(ya(e),e.length===0)return`.`;if(this.isDataUrl(e)||this.isBlobUrl(e))return e;e=this.toPosix(e);let t=``,n=e.startsWith(`/`);this.hasProtocol(e)&&(t=this.rootname(e),e=e.slice(t.length));let r=e.endsWith(`/`);return e=Ca(e,!1),e.length>0&&r&&(e+=`/`),n?`/${e}`:t+e},isAbsolute(e){return ya(e),e=this.toPosix(e),this.hasProtocol(e)?!0:e.startsWith(`/`)},join(...e){if(e.length===0)return`.`;let t;for(let n=0;n<e.length;++n){let r=e[n];if(ya(r),r.length>0)if(t===void 0)t=r;else{let i=e[n-1]??``;this.joinExtensions.includes(this.extname(i).toLowerCase())?t+=`/../${r}`:t+=`/${r}`}}return t===void 0?`.`:this.normalize(t)},dirname(e){if(ya(e),e.length===0)return`.`;e=this.toPosix(e);let t=e.charCodeAt(0),n=t===47,r=-1,i=!0,a=this.getProtocol(e),o=e;e=e.slice(a.length);for(let n=e.length-1;n>=1;--n)if(t=e.charCodeAt(n),t===47){if(!i){r=n;break}}else i=!1;return r===-1?n?`/`:this.isUrl(o)?a+e:a:n&&r===1?`//`:a+e.slice(0,r)},rootname(e){ya(e),e=this.toPosix(e);let t=``;if(t=e.startsWith(`/`)?`/`:this.getProtocol(e),this.isUrl(e)){let n=e.indexOf(`/`,t.length);t=n===-1?e:e.slice(0,n),t.endsWith(`/`)||(t+=`/`)}return t},extname(e){ya(e),e=ba(this.toPosix(e));let t=-1,n=0,r=-1,i=!0,a=0;for(let o=e.length-1;o>=0;--o){let s=e.charCodeAt(o);if(s===47){if(!i){n=o+1;break}continue}r===-1&&(i=!1,r=o+1),s===46?t===-1?t=o:a!==1&&(a=1):t!==-1&&(a=-1)}return t===-1||r===-1||a===0||a===1&&t===r-1&&t===n+1?``:e.slice(t,r)},sep:`/`,delimiter:`:`,joinExtensions:[`.html`]};function Ta(e,t){if(Array.isArray(t)){for(let n of t)if(e.startsWith(`data:${n}`))return!0;return!1}return e.startsWith(`data:${t}`)}function Ea(e,t){let n=e.split(`?`)[0],r=wa.extname(n).toLowerCase();return Array.isArray(t)?t.includes(r):r===t}function Da(e,t,n=!1){return Array.isArray(e)||(e=[e]),t?e.map(e=>typeof e==`string`||n?t(e):e):e}function Oa(e,t,n,r,i){let a=t[n];for(let o=0;o<a.length;o++){let s=a[o];n<t.length-1?Oa(e.replace(r[n],s),t,n+1,r,i):i.push(e.replace(r[n],s))}}function ka(e){let t=e.match(/\{(.*?)\}/g),n=[];if(t){let r=[];t.forEach(e=>{let t=e.substring(1,e.length-1).split(`,`);r.push(t)}),Oa(e,r,0,t,n)}else n.push(e);return n}var Aa=e=>!Array.isArray(e),ja={extension:{type:`cache-parser`,name:`cacheTextureArray`},test:e=>Array.isArray(e)&&e.every(e=>e instanceof I),getCacheableAssets:(e,t)=>{let n={};return e.forEach(e=>{t.forEach((t,r)=>{n[e+(r===0?``:r+1)]=t})}),n}},Ma=new class{constructor(){this._parsers=[],this._cache=new Map,this._cacheMap=new Map}reset(){this._cacheMap.clear(),this._cache.clear()}has(e){return this._cache.has(e)}get(e){let t=this._cache.get(e);return t||gt(`[Assets] Asset id ${e} was not found in the Cache`),t}set(e,t){let n=Da(e),r;for(let e=0;e<this.parsers.length;e++){let i=this.parsers[e];if(i.test(t)){r=i.getCacheableAssets(n,t);break}}let i=new Map(Object.entries(r||{}));r||n.forEach(e=>{i.set(e,t)});let a=[...i.keys()],o={cacheKeys:a,keys:n};n.forEach(e=>{this._cacheMap.set(e,o)}),a.forEach(e=>{let n=r?r[e]:t;this._cache.has(e)&&this._cache.get(e)!==n&&gt(`[Cache] already has key:`,e),this._cache.set(e,i.get(e))})}remove(e){if(!this._cacheMap.has(e)){gt(`[Assets] Asset id ${e} was not found in the Cache`);return}let t=this._cacheMap.get(e);t.cacheKeys.forEach(e=>{this._cache.delete(e)}),t.keys.forEach(e=>{this._cacheMap.delete(e)})}get parsers(){return this._parsers}};async function Na(e){if(`Image`in globalThis)return new Promise(t=>{let n=new Image;n.onload=()=>{t(!0)},n.onerror=()=>{t(!1)},n.src=e});if(`createImageBitmap`in globalThis&&`fetch`in globalThis){try{let t=await(await fetch(e)).blob();await createImageBitmap(t)}catch{return!1}return!0}return!1}var Pa={extension:{type:`detection-parser`,priority:1},test:async()=>Na(`data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=`),add:async e=>[...e,`avif`],remove:async e=>e.filter(e=>e!==`avif`)},Fa={extension:{type:`detection-parser`,priority:0},test:async()=>Na(`data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=`),add:async e=>[...e,`webp`],remove:async e=>e.filter(e=>e!==`webp`)},Ia=[`png`,`jpg`,`jpeg`],La={extension:{type:`detection-parser`,priority:-1},test:()=>Promise.resolve(!0),add:async e=>[...e,...Ia],remove:async e=>e.filter(e=>!Ia.includes(e))},Ra=class e{constructor(){this.loadOptions={...e.defaultOptions},this._parsers=[],this._parserHash={},this._parsersValidated=!1,this.parsers=new Proxy(this._parsers,{set:(e,t,n)=>(this._parsersValidated=!1,e[t]=n,!0)}),this.promiseCache={}}static{this.defaultOptions={onProgress:void 0,onError:void 0,strategy:`throw`,retryCount:3,retryDelay:250}}reset(){this._parsersValidated=!1,this.promiseCache={}}_getLoadPromiseAndParser(e,t){let n={promise:null,parser:null};return n.promise=(async()=>{let r=null,i=null;if((t.parser||t.loadParser)&&(i=this._parserHash[t.parser||t.loadParser],t.loadParser&&gt(`[Assets] "loadParser" is deprecated, use "parser" instead for ${e}`),i||gt(`[Assets] specified load parser "${t.parser||t.loadParser}" not found while loading ${e}`)),!i){for(let n=0;n<this.parsers.length;n++){let r=this.parsers[n];if(r.load&&r.test?.(e,t,this)){i=r;break}}if(!i)return gt(`[Assets] ${e} could not be loaded as we don't know how to parse it, ensure the correct parser has been added`),null}r=await i.load.call(i,e,t,this),n.parser=i;for(let e=0;e<this.parsers.length;e++){let i=this.parsers[e];i.parse&&i.parse&&await i.testParse?.(r,t,this)&&(r=await i.parse(r,t,this)||r,n.parser=i)}return r})(),n}async load(t,n){this._parsersValidated||this._validateParsers();let{onProgress:r,onError:i,strategy:a,retryCount:o,retryDelay:s}=typeof n==`function`?{...e.defaultOptions,...this.loadOptions,onProgress:n}:{...e.defaultOptions,...this.loadOptions,...n||{}},c=0,l={},u=Aa(t),d=Da(t,e=>({alias:[e],src:e,data:{}})),f=d.reduce((e,t)=>e+(t.progressSize||1),0),p=d.map(async e=>{let t=wa.toAbsolute(e.src);l[e.src]||(await this._loadAssetWithRetry(t,e,{onProgress:r,onError:i,strategy:a,retryCount:o,retryDelay:s},l),c+=e.progressSize||1,r&&r(c/f))});return await Promise.all(p),u?l[d[0].src]:l}async unload(e){let t=Da(e,e=>({alias:[e],src:e})).map(async e=>{let t=wa.toAbsolute(e.src),n=this.promiseCache[t];if(n){let r=await n.promise;delete this.promiseCache[t],await n.parser?.unload?.(r,e,this)}});await Promise.all(t)}_validateParsers(){this._parsersValidated=!0,this._parserHash=this._parsers.filter(e=>e.name||e.id).reduce((e,t)=>(!t.name&&!t.id?gt(`[Assets] parser should have an id`):(e[t.name]||e[t.id])&&gt(`[Assets] parser id conflict "${t.id}"`),e[t.name]=t,t.id&&(e[t.id]=t),e),{})}async _loadAssetWithRetry(e,t,n,r){let i=0,{onError:a,strategy:o,retryCount:s,retryDelay:c}=n,l=e=>new Promise(t=>setTimeout(t,e));for(;;)try{this.promiseCache[e]||(this.promiseCache[e]=this._getLoadPromiseAndParser(e,t)),r[t.src]=await this.promiseCache[e].promise;return}catch(n){if(delete this.promiseCache[e],delete r[t.src],i++,o===`retry`&&!(o!==`retry`||i>s)){a&&a(n,t),await l(c);continue}if(o===`skip`){a&&a(n,t);return}a&&a(n,t);let u=Error(`[Loader.load] Failed to load ${e}.\n${n}`);throw n instanceof Error&&n.stack&&(u.stack=n.stack),u}}},za=function(e){return e[e.Low=0]=`Low`,e[e.Normal=1]=`Normal`,e[e.High=2]=`High`,e}({}),Ba=`.json`,Va=`application/json`,Ha={extension:{type:`load-parser`,priority:za.Low},name:`loadJson`,id:`json`,test(e){return Ta(e,Va)||Ea(e,Ba)},async load(e){return await(await oa.get().fetch(e)).json()}},Ua=`.txt`,Wa=`text/plain`,Ga={name:`loadTxt`,id:`text`,extension:{type:`load-parser`,priority:za.Low,name:`loadTxt`},test(e){return Ta(e,Wa)||Ea(e,Ua)},async load(e){return await(await oa.get().fetch(e)).text()}},Ka=class{constructor(){this._defaultBundleIdentifierOptions={connector:`-`,createBundleAssetId:(e,t)=>`${e}${this._bundleIdConnector}${t}`,extractAssetIdFromBundle:(e,t)=>t.replace(`${e}${this._bundleIdConnector}`,``)},this._bundleIdConnector=this._defaultBundleIdentifierOptions.connector,this._createBundleAssetId=this._defaultBundleIdentifierOptions.createBundleAssetId,this._extractAssetIdFromBundle=this._defaultBundleIdentifierOptions.extractAssetIdFromBundle,this._assetMap={},this._preferredOrder=[],this._parsers=[],this._resolverHash={},this._rootPath=null,this._basePath=null,this._manifest=null,this._bundles={},this._defaultSearchParams=null}static{this.RETINA_PREFIX=/@([0-9\.]+)x/}setBundleIdentifier(e){if(this._bundleIdConnector=e.connector??this._bundleIdConnector,this._createBundleAssetId=e.createBundleAssetId??this._createBundleAssetId,this._extractAssetIdFromBundle=e.extractAssetIdFromBundle??this._extractAssetIdFromBundle,this._extractAssetIdFromBundle(`foo`,this._createBundleAssetId(`foo`,`bar`))!==`bar`)throw Error(`[Resolver] GenerateBundleAssetId are not working correctly`)}prefer(...e){e.forEach(e=>{this._preferredOrder.push(e),e.priority||=Object.keys(e.params)}),this._resolverHash={}}set basePath(e){this._basePath=e}get basePath(){return this._basePath}set rootPath(e){this._rootPath=e}get rootPath(){return this._rootPath}get parsers(){return this._parsers}reset(){this.setBundleIdentifier(this._defaultBundleIdentifierOptions),this._assetMap={},this._preferredOrder=[],this._resolverHash={},this._rootPath=null,this._basePath=null,this._manifest=null,this._bundles={},this._defaultSearchParams=null}setDefaultSearchParams(e){if(typeof e==`string`)this._defaultSearchParams=e;else{let t=e;this._defaultSearchParams=Object.keys(t).map(e=>`${encodeURIComponent(e)}=${encodeURIComponent(t[e])}`).join(`&`)}}getAlias(e){let{alias:t,src:n}=e;return Da(t||n,e=>typeof e==`string`?e:Array.isArray(e)?e.map(e=>e?.src??e):e?.src?e.src:e,!0)}removeAlias(e,t){this._assetMap[e]&&(t&&t!==this._resolverHash[e]||(delete this._resolverHash[e],delete this._assetMap[e]))}addManifest(e){this._manifest&&gt(`[Resolver] Manifest already exists, this will be overwritten`),this._manifest=e,e.bundles.forEach(e=>{this.addBundle(e.name,e.assets)})}addBundle(e,t){let n=[],r=t;Array.isArray(t)||(r=Object.entries(t).map(([e,t])=>typeof t==`string`||Array.isArray(t)?{alias:e,src:t}:{alias:e,...t})),r.forEach(t=>{let r=t.src,i=t.alias,a;if(typeof i==`string`){let t=this._createBundleAssetId(e,i);n.push(t),a=[i,t]}else{let t=i.map(t=>this._createBundleAssetId(e,t));n.push(...t),a=[...i,...t]}this.add({...t,alias:a,src:r})}),this._bundles[e]=n}add(e){let t=[];Array.isArray(e)?t.push(...e):t.push(e);let n=e=>{this.hasKey(e)&&gt(`[Resolver] already has key: ${e} overwriting`)};Da(t).forEach(e=>{let{src:t}=e,{data:r,format:i,loadParser:a,parser:o}=e,s=Da(t).map(e=>typeof e==`string`?ka(e):Array.isArray(e)?e:[e]),c=this.getAlias(e);Array.isArray(c)?c.forEach(n):n(c);let l=[],u=e=>({src:e,...this._parsers.find(t=>t.test(e))?.parse(e)});s.forEach(t=>{t.forEach(t=>{let n={};if(typeof t==`object`?(r=t.data??r,i=t.format??i,(t.loadParser||t.parser)&&(a=t.loadParser??a,o=t.parser??o),n={...u(t.src),...t}):n=u(t),!c)throw Error(`[Resolver] alias is undefined for this asset: ${n.src}`);n=this._buildResolvedAsset(n,{aliases:c,data:r,format:i,loadParser:a,parser:o,progressSize:e.progressSize}),l.push(n)})}),c.forEach(e=>{this._assetMap[e]=l})})}resolveBundle(e){let t=Aa(e);e=Da(e);let n={};return e.forEach(e=>{let t=this._bundles[e];if(t){let r=this.resolve(t),i={};for(let t in r){let n=r[t];i[this._extractAssetIdFromBundle(e,t)]=n}n[e]=i}}),t?n[e[0]]:n}resolveUrl(e){let t=this.resolve(e);if(typeof e!=`string`){let e={};for(let n in t)e[n]=t[n].src;return e}return t.src}resolve(e){let t=Aa(e);e=Da(e);let n={};return e.forEach(e=>{if(!this._resolverHash[e])if(this._assetMap[e]){let t=this._assetMap[e],n=this._getPreferredOrder(t);n?.priority.forEach(e=>{n.params[e].forEach(n=>{let r=t.filter(t=>t[e]?t[e]===n:!1);r.length&&(t=r)})}),this._resolverHash[e]=t[0]}else this._resolverHash[e]=this._buildResolvedAsset({alias:[e],src:e},{});n[e]=this._resolverHash[e]}),t?n[e[0]]:n}hasKey(e){return!!this._assetMap[e]}hasBundle(e){return!!this._bundles[e]}_getPreferredOrder(e){for(let t=0;t<e.length;t++){let n=e[t],r=this._preferredOrder.find(e=>e.params.format.includes(n.format));if(r)return r}return this._preferredOrder[0]}_appendDefaultSearchParams(e){return this._defaultSearchParams?`${e}${/\?/.test(e)?`&`:`?`}${this._defaultSearchParams}`:e}_buildResolvedAsset(e,t){let{aliases:n,data:r,loadParser:i,parser:a,format:o,progressSize:s}=t;return(this._basePath||this._rootPath)&&(e.src=wa.toAbsolute(e.src,this._basePath,this._rootPath)),e.alias=n??e.alias??[e.src],e.src=this._appendDefaultSearchParams(e.src),e.data={...r||{},...e.data},e.loadParser=i??e.loadParser,e.parser=a??e.parser,e.format=o??e.format??qa(e.src),s!==void 0&&(e.progressSize=s),e}};function qa(e){return e.split(`.`).pop().split(`?`).shift().split(`#`).shift()}function Ja(e,t=1){let n=Ka.RETINA_PREFIX?.exec(e);return n?parseFloat(n[1]):t}var Ya=`(function () {
    'use strict';

    const WHITE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    async function checkImageBitmap() {
      try {
        if (typeof createImageBitmap !== "function") return false;
        const response = await fetch(WHITE_PNG);
        const imageBlob = await response.blob();
        const imageBitmap = await createImageBitmap(imageBlob);
        return imageBitmap.width === 1 && imageBitmap.height === 1;
      } catch (_e) {
        return false;
      }
    }
    void checkImageBitmap().then((result) => {
      self.postMessage(result);
    });

})();
`,Xa=`(function () {
    'use strict';

    async function loadImageBitmap(url, alphaMode) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(\`[WorkerManager.loadImageBitmap] Failed to fetch \${url}: \${response.status} \${response.statusText}\`);
      }
      const imageBlob = await response.blob();
      return alphaMode === "premultiplied-alpha" ? createImageBitmap(imageBlob, { premultiplyAlpha: "none" }) : createImageBitmap(imageBlob);
    }
    self.onmessage = async (event) => {
      try {
        const imageBitmap = await loadImageBitmap(event.data.data[0], event.data.data[1]);
        self.postMessage({
          data: imageBitmap,
          uuid: event.data.uuid,
          id: event.data.id
        }, [imageBitmap]);
      } catch (e) {
        self.postMessage({
          error: e,
          uuid: event.data.uuid,
          id: event.data.id
        });
      }
    };

})();
`,Za=class{constructor(e){this._code=e,this._url=null}create(){return this._url||=URL.createObjectURL(new Blob([this._code],{type:`application/javascript`})),new Worker(this._url)}revokeObjectURL(){this._url&&=(URL.revokeObjectURL(this._url),null)}},Qa=new Za(Ya),$a=new Za(Xa),eo=0,to,no=new class{constructor(){this._initialized=!1,this._createdWorkers=0,this._workerPool=[],this._queue=[],this._resolveHash={}}isImageBitmapSupported(){return this._isImageBitmapSupported===void 0&&(this._isImageBitmapSupported=new Promise(e=>{let t=Qa.create();t.addEventListener(`message`,n=>{t.terminate(),Qa.revokeObjectURL(),e(n.data)})})),this._isImageBitmapSupported}loadImageBitmap(e,t){return this._run(`loadImageBitmap`,[e,t?.data?.alphaMode])}async _initWorkers(){this._initialized||=!0}_getWorker(){to===void 0&&(to=navigator.hardwareConcurrency||4);let e=this._workerPool.pop();return!e&&this._createdWorkers<to&&(this._createdWorkers++,e=$a.create(),e.addEventListener(`message`,e=>{this._complete(e.data),this._returnWorker(e.target),this._next()})),e}_returnWorker(e){this._workerPool.push(e)}_complete(e){this._resolveHash[e.uuid]&&(e.error===void 0?this._resolveHash[e.uuid].resolve(e.data):this._resolveHash[e.uuid].reject(e.error),delete this._resolveHash[e.uuid])}async _run(e,t){await this._initWorkers();let n=new Promise((n,r)=>{this._queue.push({id:e,arguments:t,resolve:n,reject:r})});return this._next(),n}_next(){if(!this._queue.length)return;let e=this._getWorker();if(!e)return;let t=this._queue.pop(),n=t.id;this._resolveHash[eo]={resolve:t.resolve,reject:t.reject},e.postMessage({data:t.arguments,uuid:eo++,id:n})}reset(){this._workerPool.forEach(e=>e.terminate()),this._workerPool.length=0,Object.values(this._resolveHash).forEach(({reject:e})=>{e?.(Error(`WorkerManager has been reset before completion`))}),this._resolveHash={},this._queue.length=0,this._initialized=!1,this._createdWorkers=0}},ro=[`.jpeg`,`.jpg`,`.png`,`.webp`,`.avif`],io=[`image/jpeg`,`image/png`,`image/webp`,`image/avif`];async function ao(e,t){let n=await oa.get().fetch(e);if(!n.ok)throw Error(`[loadImageBitmap] Failed to fetch ${e}: ${n.status} ${n.statusText}`);let r=await n.blob();return t?.data?.alphaMode===`premultiplied-alpha`?createImageBitmap(r,{premultiplyAlpha:`none`}):createImageBitmap(r)}function oo(e,t,n){e.label=n,e._sourceOrigin=n;let r=new I({source:e,label:n}),i=()=>{delete t.promiseCache[n],Ma.has(n)&&Ma.remove(n)};return r.source.once(`destroy`,()=>{t.promiseCache[n]&&(gt(`[Assets] A TextureSource managed by Assets was destroyed instead of unloaded! Use Assets.unload() instead of destroying the TextureSource.`),i())}),r.once(`destroy`,()=>{e.destroyed||(gt(`[Assets] A Texture managed by Assets was destroyed instead of unloaded! Use Assets.unload() instead of destroying the Texture.`),i())}),r}var so={name:`loadTextures`,id:`texture`,extension:{type:`load-parser`,priority:za.High,name:`loadTextures`},config:{preferWorkers:!0,preferCreateImageBitmap:!0,crossOrigin:`anonymous`},test(e){return Ta(e,io)||Ea(e,ro)},async load(e,t,n){let r=this.config,i=null;return i=globalThis.createImageBitmap&&r.preferCreateImageBitmap?r.preferWorkers&&await no.isImageBitmapSupported()?await no.loadImageBitmap(e,t):await ao(e,t):await new Promise((t,n)=>{let i=oa.get().createImage();i.crossOrigin=r.crossOrigin,i.src=e,i.complete?t(i):(i.onload=()=>{t(i)},i.onerror=n)}),oo(new de({resource:i,alphaMode:`premultiply-alpha-on-upload`,resolution:t?.data?.resolution||Ja(e),...t?.data}),n,e)},unload(e){e.destroy(!0)}},co={extension:{type:`resolve-parser`,name:`resolveTexture`},test:e=>so.test(e),parse:e=>({resolution:parseFloat(Ka.RETINA_PREFIX.exec(e)?.[1]??`1`),format:e.split(`.`).pop(),src:e})},lo={extension:{type:`resolve-parser`,priority:-2,name:`resolveJson`},test:e=>Ka.RETINA_PREFIX.test(e)&&e.endsWith(`.json`),parse:co.parse},uo=class{constructor(){this._detections=[],this._initialized=!1,this.resolver=new Ka,this.loader=new Ra,this.cache=Ma,this.reset()}async init(e={}){if(this._initialized){gt(`[Assets]AssetManager already initialized, did you load before calling this Assets.init()?`);return}if(this._initialized=!0,e.defaultSearchParams&&this.resolver.setDefaultSearchParams(e.defaultSearchParams),e.basePath&&(this.resolver.basePath=e.basePath),e.bundleIdentifier&&this.resolver.setBundleIdentifier(e.bundleIdentifier),e.manifest){let t=e.manifest;typeof t==`string`&&(t=await this.load(t)),this.resolver.addManifest(t)}let t=e.texturePreference?.resolution??1,n=typeof t==`number`?[t]:t,r=await this._detectFormats({preferredFormats:e.texturePreference?.format,skipDetections:e.skipDetections,detections:this._detections});this.resolver.prefer({params:{format:r,resolution:n}}),e.preferences&&this.setPreferences(e.preferences),e.loadOptions&&(this.loader.loadOptions={...this.loader.loadOptions,...e.loadOptions})}add(e){this.resolver.add(e)}async load(e,t){this._initialized||await this.init();let n=Aa(e),r=Da(e).map(e=>{if(typeof e!=`string`){let t=this.resolver.getAlias(e);return t.some(e=>!this.resolver.hasKey(e))&&this.add(e),Array.isArray(t)?t[0]:t}return this.resolver.hasKey(e)||this.add({alias:e,src:e}),e}),i=this.resolver.resolve(r),a=await this._mapLoadToResolve(i,t);return n?a[r[0]]:a}addBundle(e,t){this.resolver.addBundle(e,t)}async loadBundle(e,t){this._initialized||await this.init();let n=!1;typeof e==`string`&&(n=!0,e=[e]);let r=this.resolver.resolveBundle(e),i={},a=Object.keys(r),o=0,s=[],c=()=>{t?.(s.reduce((e,t)=>e+t,0)/o)},l=a.map((e,t)=>{let n=r[e],a=Object.values(n),l=[...new Set(a.flat())].reduce((e,t)=>e+(t.progressSize||1),0);return s.push(0),o+=l,this._mapLoadToResolve(n,e=>{s[t]=e*l,c()}).then(t=>{i[e]=t})});return await Promise.all(l),n?i[e[0]]:i}reset(){this.resolver.reset(),this.loader.reset(),this.cache.reset(),this._initialized=!1}get(e){if(typeof e==`string`)return Ma.get(e);let t={};for(let n=0;n<e.length;n++)t[n]=Ma.get(e[n]);return t}async _mapLoadToResolve(e,t){let n=[...new Set(Object.values(e))],r=await this.loader.load(n,t),i={};return n.forEach(e=>{let t=r[e.src],n=[e.src];e.alias&&n.push(...e.alias),n.forEach(e=>{i[e]=t}),Ma.set(n,t)}),i}async unload(e){this._initialized||await this.init();let t=Da(e).map(e=>typeof e==`string`?e:e.src),n=this.resolver.resolve(t);await this._unloadFromResolved(n)}async unloadBundle(e){this._initialized||await this.init(),e=Da(e);let t=this.resolver.resolveBundle(e),n=Object.keys(t).map(e=>this._unloadFromResolved(t[e]));await Promise.all(n)}async _unloadFromResolved(e){let t=Object.values(e);t.forEach(e=>{Ma.remove(e.src)}),await this.loader.unload(t)}async _detectFormats(e){let t=[];e.preferredFormats&&(t=Array.isArray(e.preferredFormats)?e.preferredFormats:[e.preferredFormats]);for(let n of e.detections)e.skipDetections||await n.test()?t=await n.add(t):e.skipDetections||(t=await n.remove(t));return t=t.filter((e,n)=>t.indexOf(e)===n),t}get detections(){return this._detections}setPreferences(e){this.loader.parsers.forEach(t=>{t.config&&Object.keys(t.config).filter(t=>t in e).forEach(n=>{t.config[n]=e[n]})})}};function fo(e,...t){let n=e=>e.extension?.priority??-1;for(let r of t)e.includes(r)||(e.push(r),e.sort((e,t)=>n(t)-n(e)))}var po=new uo;fo(po.cache.parsers,ja),fo(po.detections,La,Pa,Fa),fo(po.loader.parsers,Ha,Ga,so),fo(po.resolver.parsers,co,lo),ve(e=>{if(!Ma.has(e))return;let t=Ma.get(e);return t instanceof I?t:void 0});var mo=new S,ho=class{constructor(){this.packAsQuad=!1,this.batcherName=`default`,this.topology=`triangle-list`,this.applyTransform=!0,this.roundPixels=0,this.indexOffset=0,this.indexSize=0,this.attributeOffset=0,this.attributeSize=0,this.baseColor=16777215,this.alpha=1,this.renderable=null}get uvs(){return this.geometryData.uvs}get positions(){return this.geometryData.vertices}get indices(){return this.geometryData.indices}get blendMode(){return this.renderable&&this.applyTransform?this.renderable.groupBlendMode:`normal`}get color(){let e=this.baseColor,t=e>>16|e&65280|(e&255)<<16,n=this.renderable;return n?Ze(t,n.groupColor)+(this.alpha*n.groupAlpha*255<<24):t+(this.alpha*255<<24)}get transform(){return this.renderable?.groupTransform||mo}copyTo(e){e.indexOffset=this.indexOffset,e.indexSize=this.indexSize,e.attributeOffset=this.attributeOffset,e.attributeSize=this.attributeSize,e.baseColor=this.baseColor,e.alpha=this.alpha,e.texture=this.texture,e.geometryData=this.geometryData,e.topology=this.topology}reset(){this.applyTransform=!0,this.renderable=null,this.topology=`triangle-list`}destroy(){this.renderable=null,this.texture=null,this.geometryData=null}},go=[];function _o(){return go.pop()??new ho}function vo(e){e.reset(),e.texture=null,e.geometryData=null,go.push(e)}var yo=class e{constructor(e=0,t=0,n=0){this.type=`circle`,this.x=e,this.y=t,this.radius=n}clone(){return new e(this.x,this.y,this.radius)}contains(e,t){if(this.radius<=0)return!1;let n=this.radius*this.radius,r=this.x-e,i=this.y-t;return r*=r,i*=i,r+i<=n}strokeContains(e,t,n,r=.5){if(this.radius===0)return!1;let i=this.x-e,a=this.y-t,o=this.radius,s=(1-r)*n,c=Math.sqrt(i*i+a*a);return c<=o+s&&c>o-(n-s)}getBounds(e){return e||=new E,e.x=this.x-this.radius,e.y=this.y-this.radius,e.width=this.radius*2,e.height=this.radius*2,e}copyFrom(e){return this.x=e.x,this.y=e.y,this.radius=e.radius,this}copyTo(e){return e.copyFrom(this),e}toString(){return`[engine2d:Circle x=${this.x} y=${this.y} radius=${this.radius}]`}},bo=class e{constructor(e=0,t=0,n=0,r=0){this.type=`ellipse`,this.x=e,this.y=t,this.halfWidth=n,this.halfHeight=r}clone(){return new e(this.x,this.y,this.halfWidth,this.halfHeight)}contains(e,t){if(this.halfWidth<=0||this.halfHeight<=0)return!1;let n=(e-this.x)/this.halfWidth,r=(t-this.y)/this.halfHeight;return n*=n,r*=r,n+r<=1}strokeContains(e,t,n,r=.5){let{halfWidth:i,halfHeight:a}=this;if(i<=0||a<=0)return!1;let o=n*(1-r),s=n-o,c=i-s,l=a-s,u=i+o,d=a+o,f=e-this.x,p=t-this.y,m=f*f/(c*c)+p*p/(l*l),h=f*f/(u*u)+p*p/(d*d);return m>1&&h<=1}getBounds(e){return e||=new E,e.x=this.x-this.halfWidth,e.y=this.y-this.halfHeight,e.width=this.halfWidth*2,e.height=this.halfHeight*2,e}copyFrom(e){return this.x=e.x,this.y=e.y,this.halfWidth=e.halfWidth,this.halfHeight=e.halfHeight,this}copyTo(e){return e.copyFrom(this),e}toString(){return`[engine2d:Ellipse x=${this.x} y=${this.y} halfWidth=${this.halfWidth} halfHeight=${this.halfHeight}]`}};function xo(e,t,n,r,i,a){let o=e-n,s=t-r,c=i-n,l=a-r,u=o*c+s*l,d=c*c+l*l,f=-1;d!==0&&(f=u/d);let p,m;f<0?(p=n,m=r):f>1?(p=i,m=a):(p=n+f*c,m=r+f*l);let h=e-p,g=t-m;return h*h+g*g}var So=class e{constructor(...e){this.type=`polygon`;let t=Array.isArray(e[0])?e[0]:e;if(typeof t[0]!=`number`){let e=[];for(let n=0,r=t.length;n<r;n++)e.push(t[n].x,t[n].y);t=e}this.points=t,this.closePath=!0}isClockwise(){let e=0,t=this.points,n=t.length;for(let r=0;r<n;r+=2){let i=t[r],a=t[r+1],o=t[(r+2)%n],s=t[(r+3)%n];e+=(o-i)*(s+a)}return e<0}containsPolygon(e){let t=this.getBounds(),n=e.getBounds();if(!t.containsRect(n))return!1;let r=e.points;for(let e=0;e<r.length;e+=2){let t=r[e],n=r[e+1];if(!this.contains(t,n))return!1}return!0}clone(){let t=new e(this.points.slice());return t.closePath=this.closePath,t}contains(e,t){let n=!1,r=this.points.length/2;for(let i=0,a=r-1;i<r;a=i++){let r=this.points[i*2],o=this.points[i*2+1],s=this.points[a*2],c=this.points[a*2+1];o>t!=c>t&&e<(s-r)*((t-o)/(c-o))+r&&(n=!n)}return n}strokeContains(e,t,n,r=.5){let i=n*n,a=i*(1-r),o=i-a,{points:s}=this,c=s.length-(this.closePath?0:2);for(let n=0;n<c;n+=2){let r=s[n],i=s[n+1],c=s[(n+2)%s.length],l=s[(n+3)%s.length];if(xo(e,t,r,i,c,l)<=(Math.sign((c-r)*(t-i)-(l-i)*(e-r))<0?o:a))return!0}return!1}getBounds(e){e||=new E;let t=this.points,n=1/0,r=-1/0,i=1/0,a=-1/0;for(let e=0,o=t.length;e<o;e+=2){let o=t[e],s=t[e+1];n=o<n?o:n,r=o>r?o:r,i=s<i?s:i,a=s>a?s:a}return e.x=n,e.width=r-n,e.y=i,e.height=a-i,e}copyFrom(e){return this.points=e.points.slice(),this.closePath=e.closePath,this}copyTo(e){return e.copyFrom(this),e}toString(){return`[engine2d:PolygoncloseStroke=${this.closePath}points=${this.points.reduce((e,t)=>`${e}, ${t}`,``)}]`}get lastX(){return this.points[this.points.length-2]}get lastY(){return this.points[this.points.length-1]}get x(){return this.points[this.points.length-2]}get y(){return this.points[this.points.length-1]}get startX(){return this.points[0]}get startY(){return this.points[1]}},Co=(e,t,n,r,i,a,o)=>{let s=e-n,c=t-r,l=Math.sqrt(s*s+c*c);return l>=i-a&&l<=i+o},wo=class e{constructor(e=0,t=0,n=0,r=0,i=20){this.type=`roundedRectangle`,this.x=e,this.y=t,this.width=n,this.height=r,this.radius=i}getBounds(e){return e||=new E,e.x=this.x,e.y=this.y,e.width=this.width,e.height=this.height,e}clone(){return new e(this.x,this.y,this.width,this.height,this.radius)}copyFrom(e){return this.x=e.x,this.y=e.y,this.width=e.width,this.height=e.height,this}copyTo(e){return e.copyFrom(this),e}contains(e,t){if(this.width<=0||this.height<=0)return!1;if(e>=this.x&&e<=this.x+this.width&&t>=this.y&&t<=this.y+this.height){let n=Math.max(0,Math.min(this.radius,Math.min(this.width,this.height)/2));if(t>=this.y+n&&t<=this.y+this.height-n||e>=this.x+n&&e<=this.x+this.width-n)return!0;let r=e-(this.x+n),i=t-(this.y+n),a=n*n;if(r*r+i*i<=a||(r=e-(this.x+this.width-n),r*r+i*i<=a)||(i=t-(this.y+this.height-n),r*r+i*i<=a)||(r=e-(this.x+n),r*r+i*i<=a))return!0}return!1}strokeContains(e,t,n,r=.5){let{x:i,y:a,width:o,height:s,radius:c}=this,l=n*(1-r),u=n-l,d=i+c,f=a+c,p=o-c*2,m=s-c*2,h=i+o,g=a+s;return(e>=i-l&&e<=i+u||e>=h-u&&e<=h+l)&&t>=f&&t<=f+m||(t>=a-l&&t<=a+u||t>=g-u&&t<=g+l)&&e>=d&&e<=d+p?!0:e<d&&t<f&&Co(e,t,d,f,c,u,l)||e>h-c&&t<f&&Co(e,t,h-c,f,c,u,l)||e>h-c&&t>g-c&&Co(e,t,h-c,g-c,c,u,l)||e<d&&t>g-c&&Co(e,t,d,g-c,c,u,l)}toString(){return`[engine2d:RoundedRectangle x=${this.x} y=${this.y}width=${this.width} height=${this.height} radius=${this.radius}]`}},To={name:`circle`,build(e,t){let n,r,i,a,o,s;if(e.type===`circle`){let t=e;if(o=s=t.radius,o<=0)return!1;n=t.x,r=t.y,i=a=0}else if(e.type===`ellipse`){let t=e;if(o=t.halfWidth,s=t.halfHeight,o<=0||s<=0)return!1;n=t.x,r=t.y,i=a=0}else{let t=e,c=t.width/2,l=t.height/2;n=t.x+c,r=t.y+l,o=s=Math.max(0,Math.min(t.radius,Math.min(c,l))),i=c-o,a=l-s}if(i<0||a<0)return!1;let c=Math.ceil(2.3*Math.sqrt(o+s)),l=c*8+(i?4:0)+(a?4:0);if(l===0)return!1;if(c===0)return t[0]=t[6]=n+i,t[1]=t[3]=r+a,t[2]=t[4]=n-i,t[5]=t[7]=r-a,!0;let u=0,d=c*4+(i?2:0)+2,f=d,p=l,m=i+o,h=a,g=n+m,_=n-m,v=r+h;if(t[u++]=g,t[u++]=v,t[--d]=v,t[--d]=_,a){let e=r-h;t[f++]=_,t[f++]=e,t[--p]=e,t[--p]=g}for(let e=1;e<c;e++){let l=Math.PI/2*(e/c),m=i+Math.cos(l)*o,h=a+Math.sin(l)*s,g=n+m,_=n-m,v=r+h,y=r-h;t[u++]=g,t[u++]=v,t[--d]=v,t[--d]=_,t[f++]=_,t[f++]=y,t[--p]=y,t[--p]=g}m=i,h=a+s,g=n+m,_=n-m,v=r+h;let y=r-h;return t[u++]=g,t[u++]=v,t[--p]=y,t[--p]=g,i&&(t[u++]=_,t[u++]=v,t[--p]=y,t[--p]=_),!0},triangulate(e,t,n,r,i,a){if(e.length===0)return;let o=0,s=0;for(let t=0;t<e.length;t+=2)o+=e[t],s+=e[t+1];o/=e.length/2,s/=e.length/2;let c=r;t[c*n]=o,t[c*n+1]=s;let l=c++;for(let r=0;r<e.length;r+=2)t[c*n]=e[r],t[c*n+1]=e[r+1],r>0&&(i[a++]=c,i[a++]=l,i[a++]=c-1),c++;i[a++]=l+1,i[a++]=l,i[a++]=c-1}},Eo={...To,name:`ellipse`},Do={...To,name:`roundedRectangle`},Oo=1e-4,ko=1e-4;function Ao(e){let t=e.length;if(t<6)return 1;let n=0;for(let r=0,i=e[t-2],a=e[t-1];r<t;r+=2){let t=e[r],o=e[r+1];n+=(t-i)*(o+a),i=t,a=o}return n<0?-1:1}function jo(e,t,n,r,i,a,o,s){let c=e-n*i,l=t-r*i,u=e+n*a,d=t+r*a,f,p;o?(f=r,p=-n):(f=-r,p=n);let m=c+f,h=l+p,g=u+f,_=d+p;return s.push(m,h),s.push(g,_),2}function Mo(e,t,n,r,i,a,o,s){let c=n-e,l=r-t,u=Math.atan2(c,l),d=Math.atan2(i-e,a-t);s&&u<d?u+=Math.PI*2:!s&&u>d&&(d+=Math.PI*2);let f=u,p=d-u,m=Math.abs(p),h=Math.sqrt(c*c+l*l),g=(15*m*Math.sqrt(h)/Math.PI>>0)+1,_=p/g;if(f+=_,s){o.push(e,t),o.push(n,r);for(let n=1,r=f;n<g;n++,r+=_)o.push(e,t),o.push(e+Math.sin(r)*h,t+Math.cos(r)*h);o.push(e,t),o.push(i,a)}else{o.push(n,r),o.push(e,t);for(let n=1,r=f;n<g;n++,r+=_)o.push(e+Math.sin(r)*h,t+Math.cos(r)*h),o.push(e,t);o.push(i,a),o.push(e,t)}return g*2}function No(e,t,n,r,i,a){let o=Oo;if(e.length===0)return;let s=t,c=s.alignment;if(t.alignment!==.5){let t=Ao(e);n&&(t*=-1),c=(c-.5)*t+.5}let l=new v(e[0],e[1]),u=new v(e[e.length-2],e[e.length-1]),d=r,f=Math.abs(l.x-u.x)<o&&Math.abs(l.y-u.y)<o;if(d){e=e.slice(),f&&(e.pop(),e.pop(),u.set(e[e.length-2],e[e.length-1]));let t=(l.x+u.x)*.5,n=(u.y+l.y)*.5;e.unshift(t,n),e.push(t,n)}let p=i,m=e.length/2,h=e.length,g=p.length/2,_=s.width/2,y=_*_,b=s.miterLimit*s.miterLimit,x=e[0],S=e[1],C=e[2],w=e[3],T=0,E=0,D=-(S-w),O=x-C,k=0,A=0,j=Math.sqrt(D*D+O*O);D/=j,O/=j,D*=_,O*=_;let M=c,N=(1-M)*2,P=M*2;d||(s.cap===`round`?h+=Mo(x-D*(N-P)*.5,S-O*(N-P)*.5,x-D*N,S-O*N,x+D*P,S+O*P,p,!0)+2:s.cap===`square`&&(h+=jo(x,S,D,O,N,P,!0,p))),p.push(x-D*N,S-O*N),p.push(x+D*P,S+O*P);for(let t=1;t<m-1;++t){x=e[(t-1)*2],S=e[(t-1)*2+1],C=e[t*2],w=e[t*2+1],T=e[(t+1)*2],E=e[(t+1)*2+1],D=-(S-w),O=x-C,j=Math.sqrt(D*D+O*O),D/=j,O/=j,D*=_,O*=_,k=-(w-E),A=C-T,j=Math.sqrt(k*k+A*A),k/=j,A/=j,k*=_,A*=_;let n=C-x,r=S-w,i=C-T,a=E-w,o=n*i+r*a,c=r*i-a*n,l=c<0;if(Math.abs(c)<.001*Math.abs(o)){p.push(C-D*N,w-O*N),p.push(C+D*P,w+O*P),o>=0&&(s.join===`round`?h+=Mo(C,w,C-D*N,w-O*N,C-k*N,w-A*N,p,!1)+4:h+=2,p.push(C-k*P,w-A*P),p.push(C+k*N,w+A*N));continue}let u=(-D+x)*(-O+w)-(-D+C)*(-O+S),d=(-k+T)*(-A+w)-(-k+C)*(-A+E),f=(n*d-i*u)/c,m=(a*u-r*d)/c,g=(f-C)*(f-C)+(m-w)*(m-w),v=C+(f-C)*N,M=w+(m-w)*N,ee=C-(f-C)*P,te=w-(m-w)*P,ne=Math.min(n*n+r*r,i*i+a*a),re=l?N:P;g<=ne+re*re*y?s.join===`bevel`||g/y>b?(l?(p.push(v,M),p.push(C+D*P,w+O*P),p.push(v,M),p.push(C+k*P,w+A*P)):(p.push(C-D*N,w-O*N),p.push(ee,te),p.push(C-k*N,w-A*N),p.push(ee,te)),h+=2):s.join===`round`?l?(p.push(v,M),p.push(C+D*P,w+O*P),h+=Mo(C,w,C+D*P,w+O*P,C+k*P,w+A*P,p,!0)+4,p.push(v,M),p.push(C+k*P,w+A*P)):(p.push(C-D*N,w-O*N),p.push(ee,te),h+=Mo(C,w,C-D*N,w-O*N,C-k*N,w-A*N,p,!1)+4,p.push(C-k*N,w-A*N),p.push(ee,te)):(p.push(v,M),p.push(ee,te)):(p.push(C-D*N,w-O*N),p.push(C+D*P,w+O*P),s.join===`round`?l?h+=Mo(C,w,C+D*P,w+O*P,C+k*P,w+A*P,p,!0)+2:h+=Mo(C,w,C-D*N,w-O*N,C-k*N,w-A*N,p,!1)+2:s.join===`miter`&&g/y<=b&&(l?(p.push(ee,te),p.push(ee,te)):(p.push(v,M),p.push(v,M)),h+=2),p.push(C-k*N,w-A*N),p.push(C+k*P,w+A*P),h+=2)}x=e[(m-2)*2],S=e[(m-2)*2+1],C=e[(m-1)*2],w=e[(m-1)*2+1],D=-(S-w),O=x-C,j=Math.sqrt(D*D+O*O),D/=j,O/=j,D*=_,O*=_,p.push(C-D*N,w-O*N),p.push(C+D*P,w+O*P),d||(s.cap===`round`?h+=Mo(C-D*(N-P)*.5,w-O*(N-P)*.5,C-D*N,w-O*N,C+D*P,w+O*P,p,!1)+2:s.cap===`square`&&(h+=jo(C,w,D,O,N,P,!1,p)));let ee=ko*ko;for(let e=g;e<h+g-2;++e)x=p[e*2],S=p[e*2+1],C=p[(e+1)*2],w=p[(e+1)*2+1],T=p[(e+2)*2],E=p[(e+2)*2+1],!(Math.abs(x*(w-E)+C*(E-S)+T*(S-w))<ee)&&a.push(e,e+1,e+2)}function Po(e,t,n,r){let i=Oo;if(e.length===0)return;let a=e[0],o=e[1],s=e[e.length-2],c=e[e.length-1],l=t||Math.abs(a-s)<i&&Math.abs(o-c)<i,u=n,d=e.length/2,f=u.length/2;for(let t=0;t<d;t++)u.push(e[t*2]),u.push(e[t*2+1]);for(let e=0;e<d-1;e++)r.push(f+e,f+e+1);l&&r.push(f+d-1,f)}function Fo(e,t,n=2){let r=t&&t.length,i=r?t[0]*n:e.length,a=Io(e,0,i,n,!0),o=[];if(!a||a.next===a.prev)return o;let s,c,l;if(r&&(a=Uo(e,t,a,n)),e.length>80*n){s=e[0],c=e[1];let t=s,r=c;for(let a=n;a<i;a+=n){let n=e[a],i=e[a+1];n<s&&(s=n),i<c&&(c=i),n>t&&(t=n),i>r&&(r=i)}l=Math.max(t-s,r-c),l=l===0?0:32767/l}return Ro(a,o,n,s,c,l,0),o}function Io(e,t,n,r,i){let a;if(i===fs(e,t,n,r)>0)for(let i=t;i<n;i+=r)a=ls(i/r|0,e[i],e[i+1],a);else for(let i=n-r;i>=t;i-=r)a=ls(i/r|0,e[i],e[i+1],a);return a&&ts(a,a.next)&&(us(a),a=a.next),a}function Lo(e,t){if(!e)return e;t||=e;let n=e,r;do if(r=!1,!n.steiner&&(ts(n,n.next)||U(n.prev,n,n.next)===0)){if(us(n),n=t=n.prev,n===n.next)break;r=!0}else n=n.next;while(r||n!==t);return t}function Ro(e,t,n,r,i,a,o){if(!e)return;!o&&a&&Jo(e,r,i,a);let s=e;for(;e.prev!==e.next;){let c=e.prev,l=e.next;if(a?Bo(e,r,i,a):zo(e)){t.push(c.i,e.i,l.i),us(e),e=l.next,s=l.next;continue}if(e=l,e===s){o?o===1?(e=Vo(Lo(e),t),Ro(e,t,n,r,i,a,2)):o===2&&Ho(e,t,n,r,i,a):Ro(Lo(e),t,n,r,i,a,1);break}}}function zo(e){let t=e.prev,n=e,r=e.next;if(U(t,n,r)>=0)return!1;let i=t.x,a=n.x,o=r.x,s=t.y,c=n.y,l=r.y,u=Math.min(i,a,o),d=Math.min(s,c,l),f=Math.max(i,a,o),p=Math.max(s,c,l),m=r.next;for(;m!==t;){if(m.x>=u&&m.x<=f&&m.y>=d&&m.y<=p&&$o(i,s,a,c,o,l,m.x,m.y)&&U(m.prev,m,m.next)>=0)return!1;m=m.next}return!0}function Bo(e,t,n,r){let i=e.prev,a=e,o=e.next;if(U(i,a,o)>=0)return!1;let s=i.x,c=a.x,l=o.x,u=i.y,d=a.y,f=o.y,p=Math.min(s,c,l),m=Math.min(u,d,f),h=Math.max(s,c,l),g=Math.max(u,d,f),_=Xo(p,m,t,n,r),v=Xo(h,g,t,n,r),y=e.prevZ,b=e.nextZ;for(;y&&y.z>=_&&b&&b.z<=v;){if(y.x>=p&&y.x<=h&&y.y>=m&&y.y<=g&&y!==i&&y!==o&&$o(s,u,c,d,l,f,y.x,y.y)&&U(y.prev,y,y.next)>=0||(y=y.prevZ,b.x>=p&&b.x<=h&&b.y>=m&&b.y<=g&&b!==i&&b!==o&&$o(s,u,c,d,l,f,b.x,b.y)&&U(b.prev,b,b.next)>=0))return!1;b=b.nextZ}for(;y&&y.z>=_;){if(y.x>=p&&y.x<=h&&y.y>=m&&y.y<=g&&y!==i&&y!==o&&$o(s,u,c,d,l,f,y.x,y.y)&&U(y.prev,y,y.next)>=0)return!1;y=y.prevZ}for(;b&&b.z<=v;){if(b.x>=p&&b.x<=h&&b.y>=m&&b.y<=g&&b!==i&&b!==o&&$o(s,u,c,d,l,f,b.x,b.y)&&U(b.prev,b,b.next)>=0)return!1;b=b.nextZ}return!0}function Vo(e,t){let n=e;do{let r=n.prev,i=n.next.next;!ts(r,i)&&ns(r,n,n.next,i)&&os(r,i)&&os(i,r)&&(t.push(r.i,n.i,i.i),us(n),us(n.next),n=e=i),n=n.next}while(n!==e);return Lo(n)}function Ho(e,t,n,r,i,a){let o=e;do{let e=o.next.next;for(;e!==o.prev;){if(o.i!==e.i&&es(o,e)){let s=cs(o,e);o=Lo(o,o.next),s=Lo(s,s.next),Ro(o,t,n,r,i,a,0),Ro(s,t,n,r,i,a,0);return}e=e.next}o=o.next}while(o!==e)}function Uo(e,t,n,r){let i=[];for(let n=0,a=t.length;n<a;n++){let o=Io(e,t[n]*r,n<a-1?t[n+1]*r:e.length,r,!1);o===o.next&&(o.steiner=!0),i.push(Zo(o))}i.sort(Wo);for(let e=0;e<i.length;e++)n=Go(i[e],n);return n}function Wo(e,t){let n=e.x-t.x;return n===0&&(n=e.y-t.y,n===0&&(n=(e.next.y-e.y)/(e.next.x-e.x)-(t.next.y-t.y)/(t.next.x-t.x))),n}function Go(e,t){let n=Ko(e,t);if(!n)return t;let r=cs(n,e);return Lo(r,r.next),Lo(n,n.next)}function Ko(e,t){let n=t,r=e.x,i=e.y,a=-1/0,o;if(ts(e,n))return n;do{if(ts(e,n.next))return n.next;if(i<=n.y&&i>=n.next.y&&n.next.y!==n.y){let e=n.x+(i-n.y)*(n.next.x-n.x)/(n.next.y-n.y);if(e<=r&&e>a&&(a=e,o=n.x<n.next.x?n:n.next,e===r))return o}n=n.next}while(n!==t);if(!o)return null;let s=o,c=o.x,l=o.y,u=1/0;n=o;do{if(r>=n.x&&n.x>=c&&r!==n.x&&Qo(i<l?r:a,i,c,l,i<l?a:r,i,n.x,n.y)){let t=Math.abs(i-n.y)/(r-n.x);os(n,e)&&(t<u||t===u&&(n.x>o.x||n.x===o.x&&qo(o,n)))&&(o=n,u=t)}n=n.next}while(n!==s);return o}function qo(e,t){return U(e.prev,e,t.prev)<0&&U(t.next,e,e.next)<0}function Jo(e,t,n,r){let i=e;do i.z===0&&(i.z=Xo(i.x,i.y,t,n,r)),i.prevZ=i.prev,i.nextZ=i.next,i=i.next;while(i!==e);i.prevZ.nextZ=null,i.prevZ=null,Yo(i)}function Yo(e){let t,n=1;do{let r=e,i;e=null;let a=null;for(t=0;r;){t++;let o=r,s=0;for(let e=0;e<n&&(s++,o=o.nextZ,o);e++);let c=n;for(;s>0||c>0&&o;)s!==0&&(c===0||!o||r.z<=o.z)?(i=r,r=r.nextZ,s--):(i=o,o=o.nextZ,c--),a?a.nextZ=i:e=i,i.prevZ=a,a=i;r=o}a.nextZ=null,n*=2}while(t>1);return e}function Xo(e,t,n,r,i){return e=(e-n)*i|0,t=(t-r)*i|0,e=(e|e<<8)&16711935,e=(e|e<<4)&252645135,e=(e|e<<2)&858993459,e=(e|e<<1)&1431655765,t=(t|t<<8)&16711935,t=(t|t<<4)&252645135,t=(t|t<<2)&858993459,t=(t|t<<1)&1431655765,e|t<<1}function Zo(e){let t=e,n=e;do(t.x<n.x||t.x===n.x&&t.y<n.y)&&(n=t),t=t.next;while(t!==e);return n}function Qo(e,t,n,r,i,a,o,s){return(i-o)*(t-s)>=(e-o)*(a-s)&&(e-o)*(r-s)>=(n-o)*(t-s)&&(n-o)*(a-s)>=(i-o)*(r-s)}function $o(e,t,n,r,i,a,o,s){return!(e===o&&t===s)&&Qo(e,t,n,r,i,a,o,s)}function es(e,t){return e.next.i!==t.i&&e.prev.i!==t.i&&!as(e,t)&&(os(e,t)&&os(t,e)&&ss(e,t)&&!!(U(e.prev,e,t.prev)||U(e,t.prev,t))||ts(e,t)&&U(e.prev,e,e.next)>0&&U(t.prev,t,t.next)>0)}function U(e,t,n){return(t.y-e.y)*(n.x-t.x)-(t.x-e.x)*(n.y-t.y)}function ts(e,t){return e.x===t.x&&e.y===t.y}function ns(e,t,n,r){let i=is(U(e,t,n)),a=is(U(e,t,r)),o=is(U(n,r,e)),s=is(U(n,r,t));return!!(i!==a&&o!==s||i===0&&rs(e,n,t)||a===0&&rs(e,r,t)||o===0&&rs(n,e,r)||s===0&&rs(n,t,r))}function rs(e,t,n){return t.x<=Math.max(e.x,n.x)&&t.x>=Math.min(e.x,n.x)&&t.y<=Math.max(e.y,n.y)&&t.y>=Math.min(e.y,n.y)}function is(e){return e>0?1:e<0?-1:0}function as(e,t){let n=e;do{if(n.i!==e.i&&n.next.i!==e.i&&n.i!==t.i&&n.next.i!==t.i&&ns(n,n.next,e,t))return!0;n=n.next}while(n!==e);return!1}function os(e,t){return U(e.prev,e,e.next)<0?U(e,t,e.next)>=0&&U(e,e.prev,t)>=0:U(e,t,e.prev)<0||U(e,e.next,t)<0}function ss(e,t){let n=e,r=!1,i=(e.x+t.x)/2,a=(e.y+t.y)/2;do n.y>a!=n.next.y>a&&n.next.y!==n.y&&i<(n.next.x-n.x)*(a-n.y)/(n.next.y-n.y)+n.x&&(r=!r),n=n.next;while(n!==e);return r}function cs(e,t){let n=ds(e.i,e.x,e.y),r=ds(t.i,t.x,t.y),i=e.next,a=t.prev;return e.next=t,t.prev=e,n.next=i,i.prev=n,r.next=n,n.prev=r,a.next=r,r.prev=a,r}function ls(e,t,n,r){let i=ds(e,t,n);return r?(i.next=r.next,i.prev=r,r.next.prev=i,r.next=i):(i.prev=i,i.next=i),i}function us(e){e.next.prev=e.prev,e.prev.next=e.next,e.prevZ&&(e.prevZ.nextZ=e.nextZ),e.nextZ&&(e.nextZ.prevZ=e.prevZ)}function ds(e,t,n){return{i:e,x:t,y:n,prev:null,next:null,z:0,prevZ:null,nextZ:null,steiner:!1}}function fs(e,t,n,r){let i=0;for(let a=t,o=n-r;a<n;a+=r)i+=(e[o]-e[a])*(e[a+1]+e[o+1]),o=a;return i}function ps(e,t,n,r,i,a,o){let s=Fo(e,t,2);if(!s)return;for(let e=0;e<s.length;e+=3)a[o++]=s[e]+i,a[o++]=s[e+1]+i,a[o++]=s[e+2]+i;let c=i*r;for(let t=0;t<e.length;t+=2)n[c]=e[t],n[c+1]=e[t+1],c+=r}var ms=[],hs={name:`polygon`,build(e,t){for(let n=0;n<e.points.length;n++)t[n]=e.points[n];return!0},triangulate(e,t,n,r,i,a){ps(e,ms,t,n,r,i,a)}},gs={name:`rectangle`,build(e,t){let n=e,r=n.x,i=n.y,a=n.width,o=n.height;return a>0&&o>0?(t[0]=r,t[1]=i,t[2]=r+a,t[3]=i,t[4]=r+a,t[5]=i+o,t[6]=r,t[7]=i+o,!0):!1},triangulate(e,t,n,r,i,a){let o=0;r*=n,t[r+o]=e[0],t[r+o+1]=e[1],o+=n,t[r+o]=e[2],t[r+o+1]=e[3],o+=n,t[r+o]=e[6],t[r+o+1]=e[7],o+=n,t[r+o]=e[4],t[r+o+1]=e[5],o+=n;let s=r/n;i[a++]=s,i[a++]=s+1,i[a++]=s+2,i[a++]=s+1,i[a++]=s+3,i[a++]=s+2}},_s={name:`triangle`,build(e,t){return t[0]=e.x,t[1]=e.y,t[2]=e.x2,t[3]=e.y2,t[4]=e.x3,t[5]=e.y3,!0},triangulate(e,t,n,r,i,a){let o=0;r*=n,t[r+o]=e[0],t[r+o+1]=e[1],o+=n,t[r+o]=e[2],t[r+o+1]=e[3],o+=n,t[r+o]=e[4],t[r+o+1]=e[5];let s=r/n;i[a++]=s,i[a++]=s+1,i[a++]=s+2}};function vs(e,t,n,r,i,a,o,s){let c=0;n*=t,i*=a;let l=s.a,u=s.b,d=s.c,f=s.d,p=s.tx,m=s.ty;for(;c<o;){let o=e[n],s=e[n+1];r[i]=l*o+d*s+p,r[i+1]=u*o+f*s+m,i+=a,n+=t,c++}}function ys(e,t,n,r){let i=0;for(t*=n;i<r;)e[t]=0,e[t+1]=0,t+=n,i++}function bs(e,t,n,r,i){let a=t.a,o=t.b,s=t.c,c=t.d,l=t.tx,u=t.ty;n||=0,r||=2,i||=e.length/r-n;let d=n*r;for(let t=0;t<i;t++){let t=e[d],n=e[d+1];e[d]=a*t+s*n+l,e[d+1]=o*t+c*n+u,d+=r}}function xs(e){return ws(Math.fround(e.alpha))}function Ss(e){let t=ws(Math.fround(e.red)),n=ws(Math.fround(e.green)),r=ws(Math.fround(e.blue));return(t*255<<16)+(n*255<<8)+(r*255|0)}function Cs(e){let t=Ss(e).toString(16),n=`#${`000000`.substring(0,6-t.length)+t}`,r=Math.round(xs(e)*255).toString(16);return n+`00`.substring(0,2-r.length)+r}function ws(e){return e<0?0:e>1?1:e}var Ts=[{offset:0,color:`white`},{offset:1,color:`black`}],Es=class e{static{this.defaultLinearOptions={start:{x:0,y:0},end:{x:0,y:1},colorStops:[],textureSpace:`local`,type:`linear`,textureSize:256,wrapMode:`clamp-to-edge`}}static{this.defaultRadialOptions={center:{x:.5,y:.5},innerRadius:0,outerRadius:.5,colorStops:[],scale:1,textureSpace:`local`,type:`radial`,textureSize:256,wrapMode:`clamp-to-edge`}}static{this.createCanvas=(e,t)=>{let n=document.createElement(`canvas`);return n.width=e,n.height=t,n}}constructor(...t){this.uid=F(`fillGradient`),this._tick=0,this.type=`linear`,this.colorStops=[];let n=ks(t),r={...n.type===`radial`?e.defaultRadialOptions:e.defaultLinearOptions,...As(n)};this._textureSize=r.textureSize,this._wrapMode=r.wrapMode,r.type===`radial`?(this.center=r.center,this.outerCenter=r.outerCenter??this.center,this.innerRadius=r.innerRadius,this.outerRadius=r.outerRadius,this.scale=r.scale,this.rotation=r.rotation):(this.start=r.start,this.end=r.end),this.textureSpace=r.textureSpace,this.type=r.type,r.colorStops.forEach(e=>{this.addColorStop(e.offset,e.color)})}addColorStop(e,t){return this.colorStops.push({offset:e,color:Cs(ne.shared.setValue(t))}),this}buildLinearGradient(){if(this.texture)return;let{x:e,y:t}=this.start,{x:n,y:r}=this.end,i=n-e,a=r-t,o=i<0||a<0;if(this._wrapMode===`clamp-to-edge`){if(i<0){let t=e;e=n,n=t,i*=-1}if(a<0){let e=t;t=r,r=e,a*=-1}}let s=this.colorStops.length?this.colorStops:Ts,c=this._textureSize,{canvas:l,context:u}=Os(c,1),d=o?u.createLinearGradient(this._textureSize,0,0,0):u.createLinearGradient(0,0,this._textureSize,0);Ds(d,s),u.fillStyle=d,u.fillRect(0,0,c,1),this.texture=new I({source:new fe({resource:l,addressMode:this._wrapMode,autoGarbageCollect:!0})});let f=Math.sqrt(i*i+a*a),p=Math.atan2(a,i),m=new S;m.scale(f/c,1),m.rotate(p),m.translate(e,t),this.textureSpace===`local`&&m.scale(c,c),this.transform=m}buildGradient(){this.texture||this._tick++,this.type===`linear`?this.buildLinearGradient():this.buildRadialGradient()}buildRadialGradient(){if(this.texture)return;let e=this.colorStops.length?this.colorStops:Ts,t=this._textureSize,{canvas:n,context:r}=Os(t,t),{x:i,y:a}=this.center,{x:o,y:s}=this.outerCenter,c=this.innerRadius,l=this.outerRadius,u=o-l,d=s-l,f=t/(l*2),p=(i-u)*f,m=(a-d)*f,h=r.createRadialGradient(p,m,c*f,(o-u)*f,(s-d)*f,l*f);Ds(h,e),r.fillStyle=e[e.length-1].color,r.fillRect(0,0,t,t),r.fillStyle=h,r.translate(p,m),r.rotate(this.rotation),r.scale(1,this.scale),r.translate(-p,-m),r.fillRect(0,0,t,t),this.texture=new I({source:new fe({resource:n,addressMode:this._wrapMode,autoGarbageCollect:!0})});let g=new S;g.scale(1/f,1/f),g.translate(u,d),this.textureSpace===`local`&&g.scale(t,t),this.transform=g}destroy(){this.texture?.destroy(!0),this.texture=null,this.transform=null,this.colorStops=[],this.start=null,this.end=null,this.center=null,this.outerCenter=null}get styleKey(){return`fill-gradient-${this.uid}-${this._tick}`}};function Ds(e,t){for(let n=0;n<t.length;n++){let r=t[n];e.addColorStop(r.offset,r.color)}}function Os(e,t){let n=Es.createCanvas(e,t);return{canvas:n,context:n.getContext(`2d`)}}function ks(e){let t=e[0]??{};return(typeof t==`number`||e[1])&&(t={type:`linear`,start:{x:e[0],y:e[1]},end:{x:e[2],y:e[3]},textureSpace:e[4],textureSize:e[5]??Es.defaultLinearOptions.textureSize}),t}function As(e){let t={};for(let n in e)e[n]!==void 0&&(t[n]=e[n]);return t}var js=new S,Ms=new E;function Ns(e,t,n,r){let i=t.matrix?e.copyFrom(t.matrix).invert():e.identity();if(t.textureSpace===`local`){let e=n.getBounds(Ms);t.width&&e.pad(t.width);let{x:r,y:a}=e,o=1/e.width,s=1/e.height,c=-r*o,l=-a*s,u=i.a,d=i.b,f=i.c,p=i.d;i.a*=o,i.b*=o,i.c*=s,i.d*=s,i.tx=c*u+l*f+i.tx,i.ty=c*d+l*p+i.ty}else i.translate(t.texture.frame.x,t.texture.frame.y),i.scale(1/t.texture.source.width,1/t.texture.source.height);let a=t.texture.source.style;return!(t.fill instanceof Es)&&a.addressMode===`clamp-to-edge`&&(a.addressMode=`repeat`,a.update()),r&&i.append(js.copyFrom(r).invert()),i}var Ps={rectangle:gs,polygon:hs,triangle:_s,circle:To,ellipse:Eo,roundedRectangle:Do},Fs=new E,Is=new S;function Ls(e,t){let{geometryData:n,batches:r}=t;r.length=0,n.indices.length=0,n.vertices.length=0,n.uvs.length=0;for(let t=0;t<e.instructions.length;t++){let i=e.instructions[t];if(i.action===`texture`)Rs(i.data,r,n);else if(i.action===`fill`||i.action===`stroke`){let e=i.action===`stroke`,t=i.data.path.shapePath,a=i.data.style,o=i.data.hole;e&&o&&zs(o.shapePath,a,!0,r,n),o&&(t.shapePrimitives[t.shapePrimitives.length-1].holes=o.shapePath.shapePrimitives),zs(t,a,e,r,n)}}}function Rs(e,t,n){let r=[],i=Ps.rectangle,a=Fs;a.x=e.dx,a.y=e.dy,a.width=e.dw,a.height=e.dh;let o=e.transform;if(!i.build(a,r))return;let{vertices:s,uvs:c,indices:l}=n,u=l.length,d=s.length/2;o&&bs(r,o),i.triangulate(r,s,2,d,l,u);let f=e.image,p=f.uvs;c.push(p.x0,p.y0,p.x1,p.y1,p.x3,p.y3,p.x2,p.y2);let m=_o();m.indexOffset=u,m.indexSize=l.length-u,m.attributeOffset=d,m.attributeSize=s.length/2-d,m.baseColor=e.style,m.alpha=e.alpha,m.texture=f,m.geometryData=n,t.push(m)}function zs(e,t,n,r,i){let{vertices:a,uvs:o,indices:s}=i;e.shapePrimitives.forEach(({shape:e,transform:c,holes:l})=>{let u=[],d=Ps[e.type];if(!d.build(e,u))return;let f=s.length,p=a.length/2,m=`triangle-list`;if(c&&bs(u,c),n){let n=e.closePath??!0,r=t;r.pixelLine?(Po(u,n,a,s),m=`line-list`):No(u,r,!1,n,a,s)}else if(l){let e=[],t=u.slice();Bs(l).forEach(n=>{e.push(t.length/2),t.push(...n)}),ps(t,e,a,2,p,s,f)}else d.triangulate(u,a,2,p,s,f);let h=o.length/2,g=t.texture;if(g!==I.WHITE){let n=Ns(Is,t,e,c);vs(a,2,p,o,h,2,a.length/2-p,n)}else ys(o,h,2,a.length/2-p);let _=_o();_.indexOffset=f,_.indexSize=s.length-f,_.attributeOffset=p,_.attributeSize=a.length/2-p,_.baseColor=t.color,_.alpha=t.alpha,_.texture=g,_.geometryData=i,_.topology=m,r.push(_)})}function Bs(e){let t=[];for(let n=0;n<e.length;n++){let r=e[n].shape,i=[];Ps[r.type].build(r,i)&&t.push(i)}return t}var Vs=class{constructor(){this.isBatchable=!1,this.context=null,this.batches=[],this.geometryData={vertices:[],uvs:[],indices:[]}}reset(){this.batches&&this.batches.forEach(e=>vo(e)),this.isBatchable=!1,this.context=null,this.batches.length=0,this.geometryData.indices.length=0,this.geometryData.vertices.length=0,this.geometryData.uvs.length=0}destroy(){this.reset(),this.batches=null,this.geometryData=null}},Hs=class e{static{this.defaultOptions={bezierSmoothness:.5}}static updateGpuContext(t){let n=!!t._gpuContext,r=t._gpuContext||e._initContext(t);if(t.dirty||!n){n&&r.reset(),Ls(t,r);let e=t.batchMode;t.customShader||e===`no-batch`?r.isBatchable=!1:e===`auto`?r.isBatchable=r.geometryData.vertices.length<400:r.isBatchable=!0,t.dirty=!1}return r}static getGpuContext(t){return t._gpuContext||e._initContext(t)}static _initContext(e){let t=new Vs;return t.context=e,e._gpuContext=t,t}},Us=8,Ws=1.1920929e-7,Gs=1,Ks=.01,qs=0,Js=0;function Ys(e,t,n,r,i,a,o,s,c,l){let u=(Gs-Math.min(.99,Math.max(0,l??Hs.defaultOptions.bezierSmoothness)))/1;return u*=u,Xs(t,n,r,i,a,o,s,c,e,u),e}function Xs(e,t,n,r,i,a,o,s,c,l){Zs(e,t,n,r,i,a,o,s,c,l,0),c.push(o,s)}function Zs(e,t,n,r,i,a,o,s,c,l,u){if(u>Us)return;let d=Math.PI,f=(e+n)/2,p=(t+r)/2,m=(n+i)/2,h=(r+a)/2,g=(i+o)/2,_=(a+s)/2,v=(f+m)/2,y=(p+h)/2,b=(m+g)/2,x=(h+_)/2,S=(v+b)/2,C=(y+x)/2;if(u>0){let u=o-e,f=s-t,p=Math.abs((n-o)*f-(r-s)*u),m=Math.abs((i-o)*f-(a-s)*u),h,g;if(p>Ws&&m>Ws){if((p+m)*(p+m)<=l*(u*u+f*f)){if(qs<Ks){c.push(S,C);return}let l=Math.atan2(a-r,i-n);if(h=Math.abs(l-Math.atan2(r-t,n-e)),g=Math.abs(Math.atan2(s-a,o-i)-l),h>=d&&(h=2*d-h),g>=d&&(g=2*d-g),h+g<qs){c.push(S,C);return}if(Js!==0){if(h>Js){c.push(n,r);return}if(g>Js){c.push(i,a);return}}}}else if(p>Ws){if(p*p<=l*(u*u+f*f)){if(qs<Ks){c.push(S,C);return}if(h=Math.abs(Math.atan2(a-r,i-n)-Math.atan2(r-t,n-e)),h>=d&&(h=2*d-h),h<qs){c.push(n,r),c.push(i,a);return}if(Js!==0&&h>Js){c.push(n,r);return}}}else if(m>Ws){if(m*m<=l*(u*u+f*f)){if(qs<Ks){c.push(S,C);return}if(h=Math.abs(Math.atan2(s-a,o-i)-Math.atan2(a-r,i-n)),h>=d&&(h=2*d-h),h<qs){c.push(n,r),c.push(i,a);return}if(Js!==0&&h>Js){c.push(i,a);return}}}else if(u=S-(e+o)/2,f=C-(t+s)/2,u*u+f*f<=l){c.push(S,C);return}}Zs(e,t,f,p,v,y,S,C,c,l,u+1),Zs(S,C,b,x,g,_,o,s,c,l,u+1)}var Qs=8,$s=1.1920929e-7,ec=1,tc=.01,nc=0;function rc(e,t,n,r,i,a,o,s){let c=(ec-Math.min(.99,Math.max(0,s??Hs.defaultOptions.bezierSmoothness)))/1;return c*=c,ic(t,n,r,i,a,o,e,c),e}function ic(e,t,n,r,i,a,o,s){ac(o,e,t,n,r,i,a,s,0),o.push(i,a)}function ac(e,t,n,r,i,a,o,s,c){if(c>Qs)return;let l=Math.PI,u=(t+r)/2,d=(n+i)/2,f=(r+a)/2,p=(i+o)/2,m=(u+f)/2,h=(d+p)/2,g=a-t,_=o-n,v=Math.abs((r-a)*_-(i-o)*g);if(v>$s){if(v*v<=s*(g*g+_*_)){if(nc<tc){e.push(m,h);return}let s=Math.abs(Math.atan2(o-i,a-r)-Math.atan2(i-n,r-t));if(s>=l&&(s=2*l-s),s<nc){e.push(m,h);return}}}else if(g=m-(t+a)/2,_=h-(n+o)/2,g*g+_*_<=s){e.push(m,h);return}ac(e,t,n,u,d,m,h,s,c+1),ac(e,m,h,f,p,a,o,s,c+1)}function oc(e,t,n,r,i,a,o,s){let c=Math.abs(i-a);(!o&&i>a||o&&a>i)&&(c=2*Math.PI-c),s||=Math.max(6,Math.floor(6*r**(1/3)*(c/Math.PI))),s=Math.max(s,3);let l=c/s,u=i;l*=o?-1:1;for(let i=0;i<s+1;i++){let i=Math.cos(u),a=Math.sin(u),o=t+i*r,s=n+a*r;e.push(o,s),u+=l}}function sc(e,t,n,r,i,a){let o=e[e.length-2],s=e[e.length-1]-n,c=o-t,l=i-n,u=r-t,d=Math.abs(s*u-c*l);if(d<1e-8||a===0){(e[e.length-2]!==t||e[e.length-1]!==n)&&e.push(t,n);return}let f=s*s+c*c,p=l*l+u*u,m=s*l+c*u,h=a*Math.sqrt(f)/d,g=a*Math.sqrt(p)/d,_=h*m/f,v=g*m/p,y=h*u+g*c,b=h*l+g*s,x=c*(g+_),S=s*(g+_),C=u*(h+v),w=l*(h+v),T=Math.atan2(S-b,x-y),E=Math.atan2(w-b,C-y);oc(e,y+t,b+n,a,T,E,c*l>u*s)}var cc=Math.PI*2,lc={centerX:0,centerY:0,ang1:0,ang2:0},uc=({x:e,y:t},n,r,i,a,o,s,c)=>{e*=n,t*=r;let l=i*e-a*t,u=a*e+i*t;return c.x=l+o,c.y=u+s,c};function dc(e,t){let n=t===-1.5707963267948966?-.551915024494:4/3*Math.tan(t/4),r=t===1.5707963267948966?.551915024494:n,i=Math.cos(e),a=Math.sin(e),o=Math.cos(e+t),s=Math.sin(e+t);return[{x:i-a*r,y:a+i*r},{x:o+s*r,y:s-o*r},{x:o,y:s}]}var fc=(e,t,n,r)=>{let i=e*r-t*n<0?-1:1,a=e*n+t*r;return a>1&&(a=1),a<-1&&(a=-1),i*Math.acos(a)},pc=(e,t,n,r,i,a,o,s,c,l,u,d,f)=>{let p=i**2,m=a**2,h=u**2,g=d**2,_=p*m-p*g-m*h;_<0&&(_=0),_/=p*g+m*h,_=Math.sqrt(_)*(o===s?-1:1);let v=_*i/a*d,y=_*-a/i*u,b=l*v-c*y+(e+n)/2,x=c*v+l*y+(t+r)/2,S=(u-v)/i,C=(d-y)/a,w=(-u-v)/i,T=(-d-y)/a,E=fc(1,0,S,C),D=fc(S,C,w,T);s===0&&D>0&&(D-=cc),s===1&&D<0&&(D+=cc),f.centerX=b,f.centerY=x,f.ang1=E,f.ang2=D};function mc(e,t,n,r,i,a,o,s=0,c=0,l=0){if(a===0||o===0)return;let u=Math.sin(s*cc/360),d=Math.cos(s*cc/360),f=d*(t-r)/2+u*(n-i)/2,p=-u*(t-r)/2+d*(n-i)/2;if(f===0&&p===0)return;a=Math.abs(a),o=Math.abs(o);let m=f**2/a**2+p**2/o**2;m>1&&(a*=Math.sqrt(m),o*=Math.sqrt(m)),pc(t,n,r,i,a,o,c,l,u,d,f,p,lc);let{ang1:h,ang2:g}=lc,{centerX:_,centerY:v}=lc,y=Math.abs(g)/(cc/4);Math.abs(1-y)<1e-7&&(y=1);let b=Math.max(Math.ceil(y),1);g/=b;let x=e[e.length-2],S=e[e.length-1],C={x:0,y:0};for(let t=0;t<b;t++){let t=dc(h,g),{x:n,y:r}=uc(t[0],a,o,d,u,_,v,C),{x:i,y:s}=uc(t[1],a,o,d,u,_,v,C),{x:c,y:l}=uc(t[2],a,o,d,u,_,v,C);Ys(e,x,S,n,r,i,s,c,l),x=c,S=l,h+=g}}function hc(e,t,n){let r=(e,t)=>{let n=t.x-e.x,r=t.y-e.y,i=Math.sqrt(n*n+r*r);return{len:i,nx:n/i,ny:r/i}},i=(t,n)=>{t===0?e.moveTo(n.x,n.y):e.lineTo(n.x,n.y)},a=t[t.length-1];for(let o=0;o<t.length;o++){let s=t[o%t.length],c=s.radius??n;if(c<=0){i(o,s),a=s;continue}let l=t[(o+1)%t.length],u=r(s,a),d=r(s,l);if(u.len<1e-4||d.len<1e-4){i(o,s),a=s;continue}let f=Math.asin(u.nx*d.ny-u.ny*d.nx),p=1,m=!1;u.nx*d.nx-u.ny*-d.ny<0?f<0?f=Math.PI+f:(f=Math.PI-f,p=-1,m=!0):f>0&&(p=-1,m=!0);let h=f/2,g,_=Math.abs(Math.cos(h)*c/Math.sin(h));_>Math.min(u.len/2,d.len/2)?(_=Math.min(u.len/2,d.len/2),g=Math.abs(_*Math.sin(h)/Math.cos(h))):g=c;let v=s.x+d.nx*_+-d.ny*g*p,y=s.y+d.ny*_+d.nx*g*p,b=Math.atan2(u.ny,u.nx)+Math.PI/2*p,x=Math.atan2(d.ny,d.nx)-Math.PI/2*p;o===0&&e.moveTo(v+Math.cos(b)*g,y+Math.sin(b)*g),e.arc(v,y,g,b,x,m),a=s}}function gc(e,t,n,r){let i=(e,t)=>Math.sqrt((e.x-t.x)**2+(e.y-t.y)**2),a=(e,t,n)=>({x:e.x+(t.x-e.x)*n,y:e.y+(t.y-e.y)*n}),o=t.length;for(let s=0;s<o;s++){let c=t[(s+1)%o],l=c.radius??n;if(l<=0){s===0?e.moveTo(c.x,c.y):e.lineTo(c.x,c.y);continue}let u=t[s],d=t[(s+2)%o],f=i(u,c),p;p=f<1e-4?c:a(c,u,Math.min(f/2,l)/f);let m=i(d,c),h;h=m<1e-4?c:a(c,d,Math.min(m/2,l)/m),s===0?e.moveTo(p.x,p.y):e.lineTo(p.x,p.y),e.quadraticCurveTo(c.x,c.y,h.x,h.y,r)}}var _c=new E,vc=class{constructor(e){this.shapePrimitives=[],this._currentPoly=null,this._bounds=new L,this._graphicsPath2D=e,this.signed=e.checkForHoles}moveTo(e,t){return this.startPoly(e,t),this}lineTo(e,t){this._ensurePoly();let n=this._currentPoly.points,r=n[n.length-2],i=n[n.length-1];return(r!==e||i!==t)&&n.push(e,t),this}arc(e,t,n,r,i,a){this._ensurePoly(!1);let o=this._currentPoly.points;return oc(o,e,t,n,r,i,a),this}arcTo(e,t,n,r,i){this._ensurePoly();let a=this._currentPoly.points;return sc(a,e,t,n,r,i),this}arcToSvg(e,t,n,r,i,a,o){let s=this._currentPoly.points;return mc(s,this._currentPoly.lastX,this._currentPoly.lastY,a,o,e,t,n,r,i),this}bezierCurveTo(e,t,n,r,i,a,o){this._ensurePoly();let s=this._currentPoly;return Ys(s.points,s.lastX,s.lastY,e,t,n,r,i,a,o),this}quadraticCurveTo(e,t,n,r,i){this._ensurePoly();let a=this._currentPoly;return rc(a.points,a.lastX,a.lastY,e,t,n,r,i),this}closePath(){return this.endPoly(!0),this}addPath(e,t){this.endPoly(),t&&!t.isIdentity()&&(e=e.clone(!0),e.transform(t));let n=this.shapePrimitives,r=n.length;for(let t=0;t<e.instructions.length;t++){let n=e.instructions[t];this[n.action](...n.data)}if(e.checkForHoles&&n.length-r>1){let e=null;for(let t=r;t<n.length;t++){let r=n[t];if(r.shape.type===`polygon`){let i=r.shape,a=e?.shape;a&&a.containsPolygon(i)?(e.holes||=[],e.holes.push(r),n.copyWithin(t,t+1),n.length--,t--):e=r}}}return this}finish(e=!1){this.endPoly(e)}rect(e,t,n,r,i){return this.drawShape(new E(e,t,n,r),i),this}circle(e,t,n,r){return this.drawShape(new yo(e,t,n),r),this}poly(e,t,n){let r=new So(e);return r.closePath=t,this.drawShape(r,n),this}regularPoly(e,t,n,r,i=0,a){r=Math.max(r|0,3);let o=-1*Math.PI/2+i,s=Math.PI*2/r,c=[];for(let i=0;i<r;i++){let r=o-i*s;c.push(e+n*Math.cos(r),t+n*Math.sin(r))}return this.poly(c,!0,a),this}roundPoly(e,t,n,r,i,a=0,o){if(r=Math.max(r|0,3),i<=0)return this.regularPoly(e,t,n,r,a);let s=n*Math.sin(Math.PI/r)-.001;i=Math.min(i,s);let c=-1*Math.PI/2+a,l=Math.PI*2/r,u=(r-2)*Math.PI/r/2;for(let a=0;a<r;a++){let r=a*l+c,s=e+n*Math.cos(r),d=t+n*Math.sin(r),f=r+Math.PI+u,p=r-Math.PI-u,m=s+i*Math.cos(f),h=d+i*Math.sin(f),g=s+i*Math.cos(p),_=d+i*Math.sin(p);a===0?this.moveTo(m,h):this.lineTo(m,h),this.quadraticCurveTo(s,d,g,_,o)}return this.closePath()}roundShape(e,t,n=!1,r){return e.length<3?this:(n?gc(this,e,t,r):hc(this,e,t),this.closePath())}filletRect(e,t,n,r,i){if(i===0)return this.rect(e,t,n,r);let a=Math.min(n,r)/2,o=Math.min(a,Math.max(-a,i)),s=e+n,c=t+r,l=o<0?-o:0,u=Math.abs(o);return this.moveTo(e,t+u).arcTo(e+l,t+l,e+u,t,u).lineTo(s-u,t).arcTo(s-l,t+l,s,t+u,u).lineTo(s,c-u).arcTo(s-l,c-l,e+n-u,c,u).lineTo(e+u,c).arcTo(e+l,c-l,e,c-u,u).closePath()}chamferRect(e,t,n,r,i,a){if(i<=0)return this.rect(e,t,n,r);let o=Math.min(i,Math.min(n,r)/2),s=e+n,c=t+r,l=[e+o,t,s-o,t,s,t+o,s,c-o,s-o,c,e+o,c,e,c-o,e,t+o];for(let e=l.length-1;e>=2;e-=2)l[e]===l[e-2]&&l[e-1]===l[e-3]&&l.splice(e-1,2);return this.poly(l,!0,a)}ellipse(e,t,n,r,i){return this.drawShape(new bo(e,t,n,r),i),this}roundRect(e,t,n,r,i,a){return this.drawShape(new wo(e,t,n,r,i),a),this}drawShape(e,t){return this.endPoly(),this.shapePrimitives.push({shape:e,transform:t}),this}startPoly(e,t){let n=this._currentPoly;return n&&this.endPoly(),n=new So,n.points.push(e,t),this._currentPoly=n,this}endPoly(e=!1){let t=this._currentPoly;return t&&t.points.length>2&&(t.closePath=e,this.shapePrimitives.push({shape:t})),this._currentPoly=null,this}_ensurePoly(e=!0){if(!this._currentPoly&&(this._currentPoly=new So,e)){let e=this.shapePrimitives[this.shapePrimitives.length-1];if(e){let t=e.shape.x,n=e.shape.y;if(e.transform&&!e.transform.isIdentity()){let r=e.transform,i=t;t=r.a*t+r.c*n+r.tx,n=r.b*i+r.d*n+r.ty}this._currentPoly.points.push(t,n)}else this._currentPoly.points.push(0,0)}}buildPath(){let e=this._graphicsPath2D;this.shapePrimitives.length=0,this._currentPoly=null;for(let t=0;t<e.instructions.length;t++){let n=e.instructions[t];this[n.action](...n.data)}this.finish()}get bounds(){let e=this._bounds;e.clear();let t=this.shapePrimitives;for(let n=0;n<t.length;n++){let r=t[n],i=r.shape.getBounds(_c);r.transform?e.addRect(i,r.transform):e.addRect(i)}return e}},yc=class e{constructor(e,t=!1){if(this.instructions=[],this.uid=F(`graphicsPath`),this._dirty=!0,this.checkForHoles=t,typeof e==`string`)throw Error(`[engine2d] GraphicsPath:不支持 SVG 路径字符串(游戏未用到,未移植 parseSVGPath)`);this.instructions=e?.slice()??[]}get shapePath(){return this._shapePath||=new vc(this),this._dirty&&(this._dirty=!1,this._shapePath.buildPath()),this._shapePath}addPath(e,t){return e=e.clone(),this.instructions.push({action:`addPath`,data:[e,t]}),this._dirty=!0,this}arc(...e){return this.instructions.push({action:`arc`,data:e}),this._dirty=!0,this}arcTo(...e){return this.instructions.push({action:`arcTo`,data:e}),this._dirty=!0,this}arcToSvg(...e){return this.instructions.push({action:`arcToSvg`,data:e}),this._dirty=!0,this}bezierCurveTo(...e){return this.instructions.push({action:`bezierCurveTo`,data:e}),this._dirty=!0,this}bezierCurveToShort(e,t,n,r,i){let a=this.instructions[this.instructions.length-1],o=this.getLastPoint(v.shared),s=0,c=0;if(!a||a.action!==`bezierCurveTo`)s=o.x,c=o.y;else{s=a.data[2],c=a.data[3];let e=o.x,t=o.y;s=e+(e-s),c=t+(t-c)}return this.instructions.push({action:`bezierCurveTo`,data:[s,c,e,t,n,r,i]}),this._dirty=!0,this}closePath(){return this.instructions.push({action:`closePath`,data:[]}),this._dirty=!0,this}ellipse(...e){return this.instructions.push({action:`ellipse`,data:e}),this._dirty=!0,this}lineTo(...e){return this.instructions.push({action:`lineTo`,data:e}),this._dirty=!0,this}moveTo(...e){return this.instructions.push({action:`moveTo`,data:e}),this}quadraticCurveTo(...e){return this.instructions.push({action:`quadraticCurveTo`,data:e}),this._dirty=!0,this}quadraticCurveToShort(e,t,n){let r=this.instructions[this.instructions.length-1],i=this.getLastPoint(v.shared),a=0,o=0;if(!r||r.action!==`quadraticCurveTo`)a=i.x,o=i.y;else{a=r.data[0],o=r.data[1];let e=i.x,t=i.y;a=e+(e-a),o=t+(t-o)}return this.instructions.push({action:`quadraticCurveTo`,data:[a,o,e,t,n]}),this._dirty=!0,this}rect(e,t,n,r,i){return this.instructions.push({action:`rect`,data:[e,t,n,r,i]}),this._dirty=!0,this}circle(e,t,n,r){return this.instructions.push({action:`circle`,data:[e,t,n,r]}),this._dirty=!0,this}roundRect(...e){return this.instructions.push({action:`roundRect`,data:e}),this._dirty=!0,this}poly(...e){return this.instructions.push({action:`poly`,data:e}),this._dirty=!0,this}regularPoly(...e){return this.instructions.push({action:`regularPoly`,data:e}),this._dirty=!0,this}roundPoly(...e){return this.instructions.push({action:`roundPoly`,data:e}),this._dirty=!0,this}roundShape(...e){return this.instructions.push({action:`roundShape`,data:e}),this._dirty=!0,this}filletRect(...e){return this.instructions.push({action:`filletRect`,data:e}),this._dirty=!0,this}chamferRect(...e){return this.instructions.push({action:`chamferRect`,data:e}),this._dirty=!0,this}star(e,t,n,r,i,a,o){i||=r/2;let s=-1*Math.PI/2+a,c=n*2,l=Math.PI*2/c,u=[];for(let n=0;n<c;n++){let a=n%2?i:r,o=n*l+s;u.push(e+a*Math.cos(o),t+a*Math.sin(o))}return this.poly(u,!0,o),this}clone(t=!1){let n=new e;if(n.checkForHoles=this.checkForHoles,!t)n.instructions=this.instructions.slice();else for(let e=0;e<this.instructions.length;e++){let t=this.instructions[e];n.instructions.push({action:t.action,data:t.data.slice()})}return n}clear(){return this.instructions.length=0,this._dirty=!0,this}transform(e){if(e.isIdentity())return this;let t=e.a,n=e.b,r=e.c,i=e.d,a=e.tx,o=e.ty,s=0,c=0,l=0,u=0,d=0,f=0,p=0,m=0;for(let h=0;h<this.instructions.length;h++){let g=this.instructions[h],_=g.data;switch(g.action){case`moveTo`:case`lineTo`:s=_[0],c=_[1],_[0]=t*s+r*c+a,_[1]=n*s+i*c+o;break;case`bezierCurveTo`:l=_[0],u=_[1],d=_[2],f=_[3],s=_[4],c=_[5],_[0]=t*l+r*u+a,_[1]=n*l+i*u+o,_[2]=t*d+r*f+a,_[3]=n*d+i*f+o,_[4]=t*s+r*c+a,_[5]=n*s+i*c+o;break;case`quadraticCurveTo`:l=_[0],u=_[1],s=_[2],c=_[3],_[0]=t*l+r*u+a,_[1]=n*l+i*u+o,_[2]=t*s+r*c+a,_[3]=n*s+i*c+o;break;case`arcToSvg`:s=_[5],c=_[6],p=_[0],m=_[1],_[0]=t*p+r*m,_[1]=n*p+i*m,_[5]=t*s+r*c+a,_[6]=n*s+i*c+o;break;case`circle`:_[4]=bc(_[3],e);break;case`rect`:_[4]=bc(_[4],e);break;case`ellipse`:_[8]=bc(_[8],e);break;case`roundRect`:_[5]=bc(_[5],e);break;case`addPath`:_[0].transform(e);break;case`poly`:_[2]=bc(_[2],e);break;default:console.warn(`[engine2d] unknown transform action`,g.action);break}}return this._dirty=!0,this}get bounds(){return this.shapePath.bounds}getLastPoint(e){let t=this.instructions.length-1,n=this.instructions[t];if(!n)return e.x=0,e.y=0,e;for(;n.action===`closePath`;){if(t--,t<0)return e.x=0,e.y=0,e;n=this.instructions[t]}switch(n.action){case`moveTo`:case`lineTo`:e.x=n.data[0],e.y=n.data[1];break;case`quadraticCurveTo`:e.x=n.data[2],e.y=n.data[3];break;case`bezierCurveTo`:e.x=n.data[4],e.y=n.data[5];break;case`arc`:case`arcToSvg`:e.x=n.data[5],e.y=n.data[6];break;case`addPath`:n.data[0].getLastPoint(e);break}return e}};function bc(e,t){return e?e.prepend(t):t.clone()}var xc={repeat:{addressModeU:`repeat`,addressModeV:`repeat`},"repeat-x":{addressModeU:`repeat`,addressModeV:`clamp-to-edge`},"repeat-y":{addressModeU:`clamp-to-edge`,addressModeV:`repeat`},"no-repeat":{addressModeU:`clamp-to-edge`,addressModeV:`clamp-to-edge`}},Sc=class{constructor(e,t){this.uid=F(`fillPattern`),this._tick=0,this.transform=new S,this.texture=e,this.transform.scale(1/e.frame.width,1/e.frame.height),t&&(e.source.style.addressModeU=xc[t].addressModeU,e.source.style.addressModeV=xc[t].addressModeV)}setTransform(e){let t=this.texture;this.transform.copyFrom(e),this.transform.invert(),this.transform.scale(1/t.frame.width,1/t.frame.height),this._tick++}get texture(){return this._texture}set texture(e){this._texture!==e&&(this._texture=e,this._tick++)}get styleKey(){return`fill-pattern-${this.uid}-${this._tick}`}destroy(){this.texture.destroy(!0),this.texture=null}};function Cc(e){return ne.isColorLike(e)}function wc(e){return e instanceof Sc}function Tc(e){return e instanceof Es}function Ec(e){return e instanceof I}function Dc(e,t,n){let r=ne.shared.setValue(t??0);e.color=Ss(r);let i=xs(r);return e.alpha=i===1?n.alpha:i,e.texture=I.WHITE,{...n,...e}}function Oc(e,t,n){return e.texture=t,{...n,...e}}function kc(e,t,n){return e.fill=t,e.color=16777215,e.texture=t.texture,e.matrix=t.transform,{...n,...e}}function Ac(e,t,n){return t.buildGradient(),e.fill=t,e.color=16777215,e.texture=t.texture,e.matrix=t.transform,e.textureSpace=t.textureSpace,{...n,...e}}function jc(e,t){let n={...t,...e},r=ne.shared.setValue(n.color);return n.alpha*=xs(r),n.color=Ss(r),n}function Mc(e,t){if(e==null)return null;let n={},r=e;return Cc(e)?Dc(n,e,t):Ec(e)?Oc(n,e,t):wc(e)?kc(n,e,t):Tc(e)?Ac(n,e,t):r.fill&&wc(r.fill)?kc(r,r.fill,t):r.fill&&Tc(r.fill)?Ac(r,r.fill,t):jc(r,t)}function Nc(e,t){let{width:n,alignment:r,miterLimit:i,cap:a,join:o,pixelLine:s,...c}=t,l=Mc(e,c);return l?{width:n,alignment:r,miterLimit:i,cap:a,join:o,pixelLine:s,...l}:null}function Pc(e,t){let n=1,r=e.shapePath.shapePrimitives;for(let e=0;e<r.length;e++){let i=r[e].shape;if(i.type!==`polygon`)continue;let a=i.points,o=a.length;if(o<6)continue;let s=i.closePath;for(let e=0;e<o;e+=2){if(!s&&(e===0||e===o-2))continue;let r=(e-2+o)%o,i=(e+2)%o,c=a[r],l=a[r+1],u=a[e],d=a[e+1],f=a[i],p=a[i+1],m=c-u,h=l-d,g=f-u,_=p-d,v=m*m+h*h,y=g*g+_*_;if(v<1e-12||y<1e-12)continue;let b=(m*g+h*_)/Math.sqrt(v*y);b<-1?b=-1:b>1&&(b=1);let x=Math.sqrt((1-b)*.5);if(x<1e-6)continue;let S=Math.min(1/x,t);S>n&&(n=S)}}return n}var Fc=new v,Ic=new S,Lc=class e extends _{constructor(...t){super(...t),this._gpuContext=null,this.autoGarbageCollect=!0,this._gcLastUsed=-1,this.uid=F(`graphicsContext`),this.dirty=!0,this.batchMode=`auto`,this.instructions=[],this.destroyed=!1,this._activePath=new yc,this._transform=new S,this._fillStyle={...e.defaultFillStyle},this._strokeStyle={...e.defaultStrokeStyle},this._stateStack=[],this._tick=0,this._bounds=new L,this._boundsDirty=!0}static{this.defaultFillStyle={color:16777215,alpha:1,texture:I.WHITE,matrix:null,fill:null,textureSpace:`local`}}static{this.defaultStrokeStyle={width:1,color:16777215,alpha:1,alignment:.5,miterLimit:10,cap:`butt`,join:`miter`,texture:I.WHITE,matrix:null,fill:null,textureSpace:`local`,pixelLine:!1}}clone(){let t=new e;return t.batchMode=this.batchMode,t.instructions=this.instructions.slice(),t._activePath=this._activePath.clone(),t._transform=this._transform.clone(),t._fillStyle={...this._fillStyle},t._strokeStyle={...this._strokeStyle},t._stateStack=this._stateStack.slice(),t._bounds=this._bounds.clone(),t._boundsDirty=!0,t}get fillStyle(){return this._fillStyle}set fillStyle(t){this._fillStyle=Mc(t,e.defaultFillStyle)}get strokeStyle(){return this._strokeStyle}set strokeStyle(t){this._strokeStyle=Nc(t,e.defaultStrokeStyle)}setFillStyle(t){return this._fillStyle=Mc(t,e.defaultFillStyle),this}setStrokeStyle(t){return this._strokeStyle=Mc(t,e.defaultStrokeStyle),this}texture(e,t,n,r,i,a){return this.instructions.push({action:`texture`,data:{image:e,dx:n||0,dy:r||0,dw:i||e.frame.width,dh:a||e.frame.height,transform:this._transform.clone(),alpha:this._fillStyle.alpha,style:t||t===0?Ss(ne.shared.setValue(t)):16777215}}),this.onUpdate(),this}beginPath(){return this._activePath=new yc,this}fill(t,n){let r,i=this.instructions[this.instructions.length-1];return r=this._tick===0&&i?.action===`stroke`?i.data.path:this._activePath.clone(),r?(t!=null&&(n!==void 0&&typeof t==`number`&&(t={color:t,alpha:n}),this._fillStyle=Mc(t,e.defaultFillStyle)),this.instructions.push({action:`fill`,data:{style:this.fillStyle,path:r}}),this.onUpdate(),this._initNextPathLocation(),this._tick=0,this):this}_initNextPathLocation(){let{x:e,y:t}=this._activePath.getLastPoint(v.shared);this._activePath.clear(),this._activePath.moveTo(e,t)}stroke(t){let n,r=this.instructions[this.instructions.length-1];return n=this._tick===0&&r?.action===`fill`?r.data.path:this._activePath.clone(),n?(t!=null&&(this._strokeStyle=Nc(t,e.defaultStrokeStyle)),this.instructions.push({action:`stroke`,data:{style:this.strokeStyle,path:n}}),this.onUpdate(),this._initNextPathLocation(),this._tick=0,this):this}cut(){for(let e=0;e<2;e++){let t=this.instructions[this.instructions.length-1-e],n=this._activePath.clone();if(t&&(t.action===`stroke`||t.action===`fill`))if(t.data.hole)t.data.hole.addPath(n);else{t.data.hole=n;break}}return this._initNextPathLocation(),this}arc(e,t,n,r,i,a){this._tick++;let o=this._transform;return this._activePath.arc(o.a*e+o.c*t+o.tx,o.b*e+o.d*t+o.ty,n,r,i,a),this}arcTo(e,t,n,r,i){this._tick++;let a=this._transform;return this._activePath.arcTo(a.a*e+a.c*t+a.tx,a.b*e+a.d*t+a.ty,a.a*n+a.c*r+a.tx,a.b*n+a.d*r+a.ty,i),this}arcToSvg(e,t,n,r,i,a,o){this._tick++;let s=this._transform;return this._activePath.arcToSvg(e,t,n,r,i,s.a*a+s.c*o+s.tx,s.b*a+s.d*o+s.ty),this}bezierCurveTo(e,t,n,r,i,a,o){this._tick++;let s=this._transform;return this._activePath.bezierCurveTo(s.a*e+s.c*t+s.tx,s.b*e+s.d*t+s.ty,s.a*n+s.c*r+s.tx,s.b*n+s.d*r+s.ty,s.a*i+s.c*a+s.tx,s.b*i+s.d*a+s.ty,o),this}closePath(){return this._tick++,this._activePath?.closePath(),this}ellipse(e,t,n,r){return this._tick++,this._activePath.ellipse(e,t,n,r,this._transform.clone()),this}circle(e,t,n){return this._tick++,this._activePath.circle(e,t,n,this._transform.clone()),this}path(e){return this._tick++,this._activePath.addPath(e,this._transform.clone()),this}lineTo(e,t){this._tick++;let n=this._transform;return this._activePath.lineTo(n.a*e+n.c*t+n.tx,n.b*e+n.d*t+n.ty),this}moveTo(e,t){this._tick++;let n=this._transform,r=this._activePath.instructions,i=n.a*e+n.c*t+n.tx,a=n.b*e+n.d*t+n.ty;return r.length===1&&r[0].action===`moveTo`?(r[0].data[0]=i,r[0].data[1]=a,this):(this._activePath.moveTo(i,a),this)}quadraticCurveTo(e,t,n,r,i){this._tick++;let a=this._transform;return this._activePath.quadraticCurveTo(a.a*e+a.c*t+a.tx,a.b*e+a.d*t+a.ty,a.a*n+a.c*r+a.tx,a.b*n+a.d*r+a.ty,i),this}rect(e,t,n,r){return this._tick++,this._activePath.rect(e,t,n,r,this._transform.clone()),this}roundRect(e,t,n,r,i){return this._tick++,this._activePath.roundRect(e,t,n,r,i,this._transform.clone()),this}poly(e,t){return this._tick++,this._activePath.poly(e,t,this._transform.clone()),this}regularPoly(e,t,n,r,i=0,a){return this._tick++,this._activePath.regularPoly(e,t,n,r,i,a),this}roundPoly(e,t,n,r,i,a){return this._tick++,this._activePath.roundPoly(e,t,n,r,i,a),this}roundShape(e,t,n,r){return this._tick++,this._activePath.roundShape(e,t,n,r),this}filletRect(e,t,n,r,i){return this._tick++,this._activePath.filletRect(e,t,n,r,i),this}chamferRect(e,t,n,r,i,a){return this._tick++,this._activePath.chamferRect(e,t,n,r,i,a),this}star(e,t,n,r,i=0,a=0){return this._tick++,this._activePath.star(e,t,n,r,i,a,this._transform.clone()),this}svg(e){throw Error(`[engine2d] GraphicsContext.svg:未移植(游戏未用到)`)}restore(){let e=this._stateStack.pop();return e&&(this._transform=e.transform,this._fillStyle=e.fillStyle,this._strokeStyle=e.strokeStyle),this}save(){return this._stateStack.push({transform:this._transform.clone(),fillStyle:{...this._fillStyle},strokeStyle:{...this._strokeStyle}}),this}getTransform(){return this._transform}resetTransform(){return this._transform.identity(),this}rotate(e){return this._transform.rotate(e),this}scale(e,t=e){return this._transform.scale(e,t),this}setTransform(e,t,n,r,i,a){return e instanceof S?(this._transform.set(e.a,e.b,e.c,e.d,e.tx,e.ty),this):(this._transform.set(e,t,n,r,i,a),this)}transform(e,t,n,r,i,a){return e instanceof S?(this._transform.append(e),this):(Ic.set(e,t,n,r,i,a),this._transform.append(Ic),this)}translate(e,t=e){return this._transform.translate(e,t),this}clear(){return this._activePath.clear(),this.instructions.length=0,this.resetTransform(),this.onUpdate(),this}onUpdate(){this._boundsDirty=!0,this.dirty=!0,this.emit(`update`,this,16)}get bounds(){if(!this._boundsDirty)return this._bounds;this._boundsDirty=!1;let e=this._bounds;e.clear();for(let t=0;t<this.instructions.length;t++){let n=this.instructions[t],r=n.action;if(r===`fill`){let t=n.data;e.addBounds(t.path.bounds)}else if(r===`texture`){let t=n.data;e.addFrame(t.dx,t.dy,t.dx+t.dw,t.dy+t.dh,t.transform)}if(r===`stroke`){let t=n.data,r=t.style.alignment,i=t.style.width*(1-r);t.style.join===`miter`&&(i*=Pc(t.path,t.style.miterLimit));let a=t.path.bounds;e.addFrame(a.minX-i,a.minY-i,a.maxX+i,a.maxY+i)}}return e.isValid||e.set(0,0,0,0),e}containsPoint(e){if(!this.bounds.containsPoint(e.x,e.y))return!1;let t=this.instructions,n=!1;for(let r=0;r<t.length;r++){let i=t[r],a=i.data,o=a.path;if(!i.action||!o)continue;let s=a.style,c=o.shapePath.shapePrimitives;for(let t=0;t<c.length;t++){let r=c[t].shape;if(!s||!r)continue;let o=c[t].transform,l=o?o.applyInverse(e,Fc):e;if(i.action===`fill`)n=r.contains(l.x,l.y);else{let e=s;n=r.strokeContains(l.x,l.y,e.width,e.alignment)}let u=a.hole;if(u){let e=u.shapePath?.shapePrimitives;if(e)for(let t=0;t<e.length;t++)e[t].shape.contains(l.x,l.y)&&(n=!1)}if(n)return!0}}return n}unload(){this.emit(`unload`,this),this._gpuContext?.destroy(),this._gpuContext=null}destroy(e=!1){if(!this.destroyed){if(this.destroyed=!0,this._stateStack.length=0,this._transform=null,this.unload(),this.emit(`destroy`,this),this.removeAllListeners(),typeof e==`boolean`?e:e?.texture){let t=typeof e==`boolean`?e:e?.textureSource;this._fillStyle.texture&&(this._fillStyle.fill&&`uid`in this._fillStyle.fill?this._fillStyle.fill.destroy():this._fillStyle.texture.destroy(t)),this._strokeStyle.texture&&(this._strokeStyle.fill&&`uid`in this._strokeStyle.fill?this._strokeStyle.fill.destroy():this._strokeStyle.texture.destroy(t))}this._fillStyle=null,this._strokeStyle=null,this.instructions=null,this._activePath=null,this._bounds=null,this._stateStack=null,this.customShader=void 0,this._transform=null}}},Rc=class e extends lt{constructor(e){e instanceof Lc&&(e={context:e});let{context:t,roundPixels:n,...r}=e||{};super({label:`Graphics`,...r}),this.renderPipeId=`graphics`,this.batched=!1,this.didViewUpdate=!0,this._context=null,this._ownedContext=null,this._batches=[],this._builtFrom=null,t?this.context=t:(this.context=this._ownedContext=new Lc,this.context.autoGarbageCollect=!0),this.didViewUpdate=!0,this.allowChildren=!1,this.roundPixels=n??!1}set context(e){e!==this._context&&(this._context&&(this._context.off(`update`,this.onViewUpdate,this),this._context.off(`unload`,this.unload,this)),this._context=e,this._context.on(`update`,this.onViewUpdate,this),this._context.on(`unload`,this.unload,this),this.onViewUpdate())}get context(){return this._context}get bounds(){return this._context.bounds}updateBounds(){}containsPoint(e){return this._context.containsPoint(e)}onViewUpdate(){super.onViewUpdate(),this.didViewUpdate=!0}unload(){this._destroyBatches(),this._builtFrom=null,this.onViewUpdate()}collectRenderables(e){let t=this._context;if(!t)return;let n=Hs.updateGpuContext(t);if(this.batched=n.isBatchable,!n.isBatchable){n.batches.length&&e.addUnbatched(this,n.batches);return}(this.didViewUpdate||this._builtFrom!==n)&&this._rebuild(n);let r=this._batches,i=this._roundPixels;for(let t=0;t<r.length;t++){let n=r[t];n.roundPixels=i,e.addBatchable(n)}}_rebuild(e){this.didViewUpdate=!1,this._destroyBatches(),this._builtFrom=e;let t=this._roundPixels;this._batches=e.batches.map(e=>{let n=_o();return e.copyTo(n),n.renderable=this,n.roundPixels=t,n})}_destroyBatches(){for(let e=0;e<this._batches.length;e++)vo(this._batches[e]);this._batches.length=0}destroy(e){this.destroyed||(this._ownedContext&&!e?this._ownedContext.destroy(e):(e===!0||e?.context===!0)&&this._context.destroy(e),this._context&&(this._context.off(`update`,this.onViewUpdate,this),this._context.off(`unload`,this.unload,this)),this._destroyBatches(),this._builtFrom=null,this._ownedContext=null,this._context=null,super.destroy(e))}_callContextMethod(e,t){return this.context[e](...t),this}setFillStyle(e){return this._callContextMethod(`setFillStyle`,[e])}setStrokeStyle(e){return this._callContextMethod(`setStrokeStyle`,[e])}fill(...e){return this._callContextMethod(`fill`,e)}stroke(e){return this._callContextMethod(`stroke`,[e])}texture(...e){return this._callContextMethod(`texture`,e)}beginPath(){return this._callContextMethod(`beginPath`,[])}cut(){return this._callContextMethod(`cut`,[])}arc(...e){return this._callContextMethod(`arc`,e)}arcTo(...e){return this._callContextMethod(`arcTo`,e)}arcToSvg(...e){return this._callContextMethod(`arcToSvg`,e)}bezierCurveTo(...e){return this._callContextMethod(`bezierCurveTo`,e)}closePath(){return this._callContextMethod(`closePath`,[])}ellipse(...e){return this._callContextMethod(`ellipse`,e)}circle(...e){return this._callContextMethod(`circle`,e)}path(...e){return this._callContextMethod(`path`,e)}lineTo(...e){return this._callContextMethod(`lineTo`,e)}moveTo(...e){return this._callContextMethod(`moveTo`,e)}quadraticCurveTo(...e){return this._callContextMethod(`quadraticCurveTo`,e)}rect(...e){return this._callContextMethod(`rect`,e)}roundRect(...e){return this._callContextMethod(`roundRect`,e)}poly(...e){return this._callContextMethod(`poly`,e)}regularPoly(...e){return this._callContextMethod(`regularPoly`,e)}roundPoly(...e){return this._callContextMethod(`roundPoly`,e)}roundShape(...e){return this._callContextMethod(`roundShape`,e)}filletRect(...e){return this._callContextMethod(`filletRect`,e)}chamferRect(...e){return this._callContextMethod(`chamferRect`,e)}star(...e){return this._callContextMethod(`star`,e)}svg(...e){return this._callContextMethod(`svg`,e)}restore(...e){return this._callContextMethod(`restore`,e)}save(){return this._callContextMethod(`save`,[])}getTransform(){return this.context.getTransform()}resetTransform(){return this._callContextMethod(`resetTransform`,[])}rotateTransform(...e){return this._callContextMethod(`rotate`,e)}scaleTransform(...e){return this._callContextMethod(`scale`,e)}setTransform(...e){return this._callContextMethod(`setTransform`,e)}transform(...e){return this._callContextMethod(`transform`,e)}translateTransform(...e){return this._callContextMethod(`translate`,e)}clear(){return this._callContextMethod(`clear`,[])}get fillStyle(){return this._context.fillStyle}set fillStyle(e){this._context.fillStyle=e}get strokeStyle(){return this._context.strokeStyle}set strokeStyle(e){this._context.strokeStyle=e}clone(t=!1){return t?new e(this._context.clone()):(this._ownedContext=null,new e(this._context))}lineStyle(e,t,n){let r={};return e&&(r.width=e),t&&(r.color=t),n&&(r.alpha=n),this.context.strokeStyle=r,this}beginFill(e,t){let n={};return e!==void 0&&(n.color=e),t!==void 0&&(n.alpha=t),this.context.fillStyle=n,this}endFill(){this.context.fill();let e=this.context.strokeStyle;return(e.width!==Lc.defaultStrokeStyle.width||e.color!==Lc.defaultStrokeStyle.color||e.alpha!==Lc.defaultStrokeStyle.alpha)&&this.context.stroke(),this}drawCircle(e,t,n){return this._callContextMethod(`circle`,[e,t,n])}drawEllipse(e,t,n,r){return this._callContextMethod(`ellipse`,[e,t,n,r])}drawPolygon(e,t){return this._callContextMethod(`poly`,[e,t])}drawRect(e,t,n,r){return this._callContextMethod(`rect`,[e,t,n,r])}drawRoundedRect(e,t,n,r,i){return this._callContextMethod(`roundRect`,[e,t,n,r,i])}drawStar(e,t,n,r,i,a){return this._callContextMethod(`star`,[e,t,n,r,i,a])}},zc={color:16777215,alpha:1,texture:I.WHITE,matrix:null,fill:null,textureSpace:`local`},Bc={width:1,color:16777215,alpha:1,alignment:.5,miterLimit:10,cap:`butt`,join:`miter`,texture:I.WHITE,matrix:null,fill:null,textureSpace:`local`,pixelLine:!1};function Vc(e){if(typeof e==`number`||typeof e==`string`||e instanceof Number||e instanceof ne||Array.isArray(e)||e instanceof Uint8Array||e instanceof Uint8ClampedArray||e instanceof Float32Array)return!0;let t=e;return t.r!==void 0&&t.g!==void 0&&t.b!==void 0||t.h!==void 0&&t.s!==void 0&&t.l!==void 0||t.h!==void 0&&t.s!==void 0&&t.v!==void 0}var Hc=e=>Math.min(Math.max(e,0),1),Uc=(e,t=0)=>{let n=10**t;return Math.round(n*e)/n},Wc=/^(#|0x)?([a-f0-9]{4}|[a-f0-9]{8})$/i;function Gc(e){if(e==null)throw Error(`Cannot set Color#value to null`);let[t,n,r,i]=ne.normalize(e);return(typeof e==`string`||typeof e==`object`&&!(e instanceof ne)&&!Array.isArray(e)&&!ArrayBuffer.isView(e))&&(typeof e==`string`&&Wc.test(e.trim())&&(i=Uc(i,2)),t=Uc(t*255)/255,n=Uc(n*255)/255,r=Uc(r*255)/255,i=Uc(i,3)),[Math.fround(Hc(t)),Math.fround(Hc(n)),Math.fround(Hc(r)),Math.fround(Hc(i))]}function Kc(e){let[t,n,r]=Gc(e);return(t*255<<16)+(n*255<<8)+(r*255|0)}function qc(e){let t=e.toString(16);return`#${`000000`.substring(0,6-t.length)+t}`}function Jc(e){return qc(Kc(e))}function Yc(e,t){let n=Gc(e),r=t===void 0?n[3]:Math.fround(Hc(t)),i=Math.round(r*255).toString(16);return qc((n[0]*255<<16)+(n[1]*255<<8)+(n[2]*255|0))+`00`.substring(0,2-i.length)+i}function Xc(e,t){let n=Gc(e),r=t===void 0?n[3]:Math.fround(Hc(t));return`rgba(${Math.round(n[0]*255)},${Math.round(n[1]*255)},${Math.round(n[2]*255)},${r})`}function Zc(e){let t=e;return!!t&&typeof t==`object`&&Array.isArray(t.colorStops)&&typeof t.addColorStop==`function`&&typeof t.buildGradient==`function`}function Qc(e){let t=e;return!!t&&typeof t==`object`&&!Zc(t)&&typeof t.setTransform==`function`&&`texture`in t&&`transform`in t}function $c(e){return e instanceof I}function el(e,t,n){let r=Gc(t??0);return e.color=(r[0]*255<<16)+(r[1]*255<<8)+(r[2]*255|0),e.alpha=r[3]===1?n.alpha:r[3],e.texture=I.WHITE,{...n,...e}}function tl(e,t,n){return e.texture=t,{...n,...e}}function nl(e,t,n){return e.fill=t,e.color=16777215,e.texture=t.texture,e.matrix=t.transform,{...n,...e}}function rl(e,t,n){return t.buildGradient(),e.fill=t,e.color=16777215,e.texture=t.texture,e.matrix=t.transform,e.textureSpace=t.textureSpace,{...n,...e}}function il(e,t){let n={...t,...e},r=Gc(n.color);return n.alpha*=r[3],n.color=(r[0]*255<<16)+(r[1]*255<<8)+(r[2]*255|0),n}function al(e,t){if(e==null)return null;let n={},r=e;return Vc(e)?el(n,e,t):$c(e)?tl(n,e,t):Qc(e)?nl(n,e,t):Zc(e)?rl(n,e,t):r.fill&&Qc(r.fill)?nl(r,r.fill,t):r.fill&&Zc(r.fill)?rl(r,r.fill,t):il(r,t)}function ol(e,t){let{width:n,alignment:r,miterLimit:i,cap:a,join:o,pixelLine:s,...c}=t,l=al(e,c);return l?{width:n,alignment:r,miterLimit:i,cap:a,join:o,pixelLine:s,...l}:null}var sl={createCanvas:(e,t)=>{let n=document.createElement(`canvas`);return n.width=e,n.height=t,n},createImage:()=>new Image,getCanvasRenderingContext2D:()=>CanvasRenderingContext2D,getNavigator:()=>navigator,fetch:(e,t)=>fetch(e,t)},cl={get(){return sl},set(e){sl=e}};function ll(e,t){return e.getContext(`2d`,t)}function ul(e){return e+=e===0?1:0,--e,e|=e>>>1,e|=e>>>2,e|=e>>>4,e|=e>>>8,e|=e>>>16,e+1}var dl=new class{constructor(e){this._canvasPool=Object.create(null),this.canvasOptions=e||{},this.enableFullScreen=!1}_createCanvasAndContext(e,t){let n=cl.get().createCanvas();return n.width=e,n.height=t,{canvas:n,context:ll(n)}}getOptimalCanvasAndContext(e,t,n=1){e=Math.ceil(e*n-1e-6),t=Math.ceil(t*n-1e-6),e=ul(e),t=ul(t);let r=(e<<17)+(t<<1);this._canvasPool[r]||(this._canvasPool[r]=[]);let i=this._canvasPool[r].pop();return i||=this._createCanvasAndContext(e,t),i}returnCanvasAndContext(e){let{width:t,height:n}=e.canvas,r=(t<<17)+(n<<1);e.context.resetTransform(),e.context.clearRect(0,0,t,n),this._canvasPool[r].push(e)}clear(){this._canvasPool={}}};function fl(e){return!!e.tagStyles&&Object.keys(e.tagStyles).length>0}function pl(e){return e.includes(`<`)}function ml(e,t){return e.clone().assign(t)}function hl(e,t){let n=[],r=t.tagStyles;if(!fl(t)||!pl(e))return n.push({text:e,style:t}),n;let i=[t],a=[],o=``,s=0;for(;s<e.length;){let t=e[s];if(t===`<`){let c=e.indexOf(`>`,s);if(c===-1){o+=t,s++;continue}let l=e.slice(s+1,c);if(l.startsWith(`/`)){let t=l.slice(1).trim();if(a.length>0&&a[a.length-1]===t){o.length>0&&(n.push({text:o,style:i[i.length-1]}),o=``),i.pop(),a.pop(),s=c+1;continue}else{o+=e.slice(s,c+1),s=c+1;continue}}else{let t=l.trim();if(r[t]){o.length>0&&(n.push({text:o,style:i[i.length-1]}),o=``);let e=i[i.length-1],l=ml(e,r[t]);i.push(l),a.push(t),s=c+1;continue}else{o+=e.slice(s,c+1),s=c+1;continue}}}else o+=t,s++}return o.length>0&&n.push({text:o,style:i[i.length-1]}),n}var gl=new Set([10,13]),_l=new Set([9,32,8192,8193,8194,8195,8196,8197,8198,8200,8201,8202,8287,12288]),vl=new Set([45,8208,8211,8212,173]),yl=/(\r\n|\r|\n)/,bl=/(?:\r\n|\r|\n)/;function xl(e){return typeof e==`string`?gl.has(e.charCodeAt(0)):!1}function Sl(e,t){return typeof e==`string`?_l.has(e.charCodeAt(0)):!1}function Cl(e){return typeof e==`string`?vl.has(e.charCodeAt(0)):!1}function wl(e){return e===`normal`||e===`pre-line`}function Tl(e){return e===`normal`}function El(e){if(typeof e!=`string`)return``;let t=e.length-1;for(;t>=0&&Sl(e[t]);)t--;return t<e.length-1?e.slice(0,t+1):e}function Dl(e){let t=[],n=[];if(typeof e!=`string`)return t;for(let r=0;r<e.length;r++){let i=e[r],a=e[r+1];if(Sl(i,a)||xl(i)){n.length>0&&(t.push(n.join(``)),n.length=0),i===`\r`&&a===`
`?(t.push(`\r
`),r++):t.push(i);continue}n.push(i),Cl(i)&&a&&!Sl(a)&&!xl(a)&&(t.push(n.join(``)),n.length=0)}return n.length>0&&t.push(n.join(``)),t}function Ol(e,t,n,r){let i=n(e),a=[];for(let n=0;n<i.length;n++){let o=i[n],s=o,c=1;for(;i[n+c];){let a=i[n+c];if(!r(s,a,e,n,t))o+=a,s=a,c++;else break}n+=c-1,a.push(o)}return a}var kl=/\r\n|\r|\n/g;function Al(e,t,n,r,i,a,o,s){let c=hl(e,t);if(Tl(t.whiteSpace))for(let e=0;e<c.length;e++){let t=c[e];c[e]={text:t.text.replace(kl,` `),style:t.style}}let l=[],u=[];for(let e of c){let t=e.text.split(yl);for(let n=0;n<t.length;n++){let r=t[n];r===`\r
`||r===`\r`||r===`
`?(l.push(u),u=[]):r.length>0&&u.push({text:r,style:e.style})}}(u.length>0||l.length===0)&&l.push(u);let d=n?jl(l,t,r,i,o,s):l,f=[],p=[],m=[],h=[],g=[],_=0,v=t._fontString,y=a(v);y.fontSize===0&&(y.fontSize=t.fontSize,y.ascent=t.fontSize);let b=``,x=!!t.dropShadow,S=t._stroke?.width||0;for(let e of d){let n=0,o=y.ascent,s=y.descent,c=``;for(let t of e){let e=t.style._fontString,l=a(e);e!==b&&(r.font=e,b=e);let u=i(t.text,t.style.letterSpacing,r);n+=u,o=Math.max(o,l.ascent),s=Math.max(s,l.descent),c+=t.text;let d=t.style._stroke?.width||0;d>S&&(S=d),!x&&t.style.dropShadow&&(x=!0)}e.length===0&&(o=y.ascent,s=y.descent),f.push(n),p.push(o),m.push(s),g.push(c);let l=t.lineHeight||o+s;h.push(l+t.leading),_=Math.max(_,n)}let C=S,w=(n&&t.align!==`left`?Math.max(_,t.wordWrapWidth):_)+C+(t.dropShadow?t.dropShadow.distance:0),T=0;for(let e=0;e<h.length;e++)T+=h[e];return T=Math.max(T,h[0]+C),{width:w,height:T+(t.dropShadow?t.dropShadow.distance:0),lines:g,lineWidths:f,lineHeight:(t.lineHeight||y.fontSize)+t.leading,maxLineWidth:_,fontProperties:y,runsByLine:d,lineAscents:p,lineDescents:m,lineHeights:h,hasDropShadow:x}}function jl(e,t,n,r,i,a){let{letterSpacing:o,whiteSpace:s,wordWrapWidth:c,breakWords:l}=t,u=wl(s),d=c+o,f={},p=``,m=(e,t)=>{let i=`${e}|${t.styleKey}`,a=f[i];if(a===void 0){let o=t._fontString;o!==p&&(n.font=o,p=o),a=r(e,t.letterSpacing,n)+t.letterSpacing,f[i]=a}return a},h=[];for(let t of e){let e=Ml(t),n=h.length,r=t=>{let n=0,r=t;do{let{token:t,style:i}=e[r];n+=m(t,i),r++}while(r<e.length&&e[r].continuesFromPrevious);return n},o=t=>{let n=[],r=t;do n.push({token:e[r].token,style:e[r].style}),r++;while(r<e.length&&e[r].continuesFromPrevious);return n},s=[],c=0,f=!u,p=null,g=()=>{p&&p.text.length>0&&s.push(p),p=null},_=()=>{if(g(),s.length>0){let e=s[s.length-1];e.text=El(e.text),e.text.length===0&&s.pop()}h.push(s),s=[],c=0,f=!1};for(let t=0;t<e.length;t++){let{token:n,style:v,continuesFromPrevious:y}=e[t],b=m(n,v);if(u){let e=Sl(n),t=p,r=t?.text[t.text.length-1]??s[s.length-1]?.text.slice(-1)??``,i=r?Sl(r):!1;if(e&&i)continue}let x=!y,S=x?r(t):b;if(S>d&&x)if(c>0&&_(),l){let e=o(t);for(let t=0;t<e.length;t++){let n=e[t].token,r=e[t].style,o=Ol(n,l,a,i);for(let e of o){let t=m(e,r);t+c>d&&_();let n=p;!n||n.style!==r?(g(),p={text:e,style:r}):n.text+=e,c+=t}}t+=e.length-1}else{let e=o(t);g(),h.push(e.map(e=>({text:e.token,style:e.style}))),f=!1,t+=e.length-1}else if(S+c>d&&x){if(Sl(n)){f=!1;continue}_(),p={text:n,style:v},c=b}else if(y&&!l){let e=p;!e||e.style!==v?(g(),p={text:n,style:v}):e.text+=n,c+=b}else{let e=Sl(n);if(c===0&&e&&!f)continue;let t=p;!t||t.style!==v?(g(),p={text:n,style:v}):t.text+=n,c+=b}}if(g(),s.length>0){let e=s[s.length-1];e.text=El(e.text),e.text.length===0&&s.pop()}(s.length>0||h.length===n)&&h.push(s)}return h}function Ml(e){let t=[],n=!1;for(let r of e){let e=Dl(r.text),i=!0;for(let a of e){let e=Sl(a)||xl(a),o=i&&n&&!e;t.push({token:a,style:r.style,continuesFromPrevious:o}),n=!e,i=!1}}return t}var Nl={willReadFrequently:!0};function Pl(e,t,n,r,i){let a=n[e];return typeof a!=`number`&&(a=i(e,t,r)+t,n[e]=a),a}function Fl(e,t,n,r,i,a,o){let s=ll(n,Nl);s.font=t._fontString;let c=0,l=``,u=[],d=Object.create(null),{letterSpacing:f,whiteSpace:p}=t,m=wl(p),h=Tl(p),g=!m,_=t.wordWrapWidth+f,v=Dl(e);for(let e=0;e<v.length;e++){let n=v[e];if(xl(n)){if(!h){u.push(El(l)),g=!m,l=``,c=0;continue}n=` `}if(m){let e=Sl(n),t=Sl(l[l.length-1]);if(e&&t)continue}let p=Pl(n,f,d,s,r);if(p>_)if(l!==``&&(u.push(El(l)),l=``,c=0),i(n,t.breakWords)){let e=Ol(n,t.breakWords,o,a);for(let t of e){let e=Pl(t,f,d,s,r);e+c>_&&(u.push(El(l)),g=!1,l=``,c=0),l+=t,c+=e}}else l.length>0&&(u.push(El(l)),l=``,c=0),u.push(El(n)),g=!1,l=``,c=0;else p+c>_&&(g=!1,u.push(El(l)),l=``,c=0),(l.length>0||!Sl(n)||g)&&(l+=n,c+=p)}let y=El(l);return y.length>0&&u.push(y),u.join(`
`)}var Il={willReadFrequently:!0},Ll=class{constructor(e){this._max=e,this._map=new Map}has(e){return this._map.has(e)}get(e){let t=this._map.get(e);return t!==void 0&&(this._map.delete(e),this._map.set(e,t)),t}set(e,t){if(this._map.has(e))this._map.delete(e);else if(this._max>0&&this._map.size>=this._max){let e=this._map.keys().next().value;this._map.delete(e)}this._map.set(e,t)}clear(){this._map.clear()}},Rl=class e{static{this.METRICS_STRING=`|ÉqÅ`}static{this.BASELINE_SYMBOL=`M`}static{this.BASELINE_MULTIPLIER=1.4}static{this.HEIGHT_MULTIPLIER=2}static{this.graphemeSegmenter=(()=>{let e=typeof Intl<`u`?Intl:void 0;if(typeof e?.Segmenter==`function`){let t=new e.Segmenter;return e=>{let n=t.segment(e),r=[],i=0;for(let e of n)r[i++]=e.segment;return r}}return e=>[...e]})()}static{this.experimentalLetterSpacing=!1}static{this._fonts={}}static{this._measurementCache=new Ll(1e3)}constructor(e,t,n,r,i,a,o,s,c,l){this.text=e,this.style=t,this.width=n,this.height=r,this.lines=i,this.lineWidths=a,this.lineHeight=o,this.maxLineWidth=s,this.fontProperties=c,l&&(this.runsByLine=l.runsByLine,this.lineAscents=l.lineAscents,this.lineDescents=l.lineDescents,this.lineHeights=l.lineHeights,this.hasDropShadow=l.hasDropShadow)}static get experimentalLetterSpacingSupported(){let t=e._experimentalLetterSpacingSupported;if(t===void 0){let n=cl.get().getCanvasRenderingContext2D().prototype;t=e._experimentalLetterSpacingSupported=`letterSpacing`in n||`textLetterSpacing`in n}return t}static measureText(t=` `,n,r=e._canvas,i=n.wordWrap){let a=`${t}-${n.styleKey}-wordWrap-${i}`;if(e._measurementCache.has(a))return e._measurementCache.get(a);if(fl(n)&&pl(t)){let r=Al(t,n,i,e._context,e._measureText,e.measureFont,e.canBreakChars,e.wordWrapSplit),o=new e(t,n,r.width,r.height,r.lines,r.lineWidths,r.lineHeight,r.maxLineWidth,r.fontProperties,{runsByLine:r.runsByLine,lineAscents:r.lineAscents,lineDescents:r.lineDescents,lineHeights:r.lineHeights,hasDropShadow:r.hasDropShadow});return e._measurementCache.set(a,o),o}let o=n._fontString,s=e.measureFont(o);s.fontSize===0&&(s.fontSize=n.fontSize,s.ascent=n.fontSize,s.descent=0);let c=e._context;c.font=o;let l=(i?e._wordWrap(t,n,r):t).split(bl),u=Array(l.length),d=0;for(let t=0;t<l.length;t++){let r=e._measureText(l[t],n.letterSpacing,c);u[t]=r,d=Math.max(d,r)}let f=n._stroke?.width??0,p=n.lineHeight||s.fontSize,m=e._getAlignWidth(d,n,i),h=e._adjustWidthForStyle(m,n),g=Math.max(p,s.fontSize+f)+(l.length-1)*(p+n.leading),_=new e(t,n,h,e._adjustHeightForStyle(g,n),l,u,p+n.leading,d,s);return e._measurementCache.set(a,_),_}static _adjustWidthForStyle(e,t){let n=e+(t._stroke?.width||0);return t.dropShadow&&(n+=t.dropShadow.distance),n}static _adjustHeightForStyle(e,t){let n=e;return t.dropShadow&&(n+=t.dropShadow.distance),n}static _getAlignWidth(e,t,n){return n&&t.align!==`left`?Math.max(e,t.wordWrapWidth):e}static _measureText(t,n,r){let i=!1;e.experimentalLetterSpacingSupported&&(e.experimentalLetterSpacing?(r.letterSpacing=`${n}px`,r.textLetterSpacing=`${n}px`,i=!0):(r.letterSpacing=`0px`,r.textLetterSpacing=`0px`));let a=r.measureText(t),o=a.width,s=-(a.actualBoundingBoxLeft??0),c=(a.actualBoundingBoxRight??0)-s;if(o>0)if(i)o-=n,c-=n;else{let r=(e.graphemeSegmenter(t).length-1)*n;o+=r,c+=r}return Math.max(o,c)}static _wordWrap(t,n,r=e._canvas){return Fl(t,n,r,e._measureText,e.canBreakWords,e.canBreakChars,e.wordWrapSplit)}static isBreakingSpace(e,t){return Sl(e,t)}static canBreakWords(e,t){return t}static canBreakChars(e,t,n,r,i){return!0}static wordWrapSplit(t){return e.graphemeSegmenter(t)}static measureFont(t){if(e._fonts[t])return e._fonts[t];let n=e._context;n.font=t;let r=n.measureText(e.METRICS_STRING+e.BASELINE_SYMBOL),i=r.actualBoundingBoxAscent??0,a=r.actualBoundingBoxDescent??0,o={ascent:i,descent:a,fontSize:i+a};return e._fonts[t]=o,o}static clearMetrics(t=``){t?delete e._fonts[t]:e._fonts={}}static get _canvas(){if(!e.__canvas){let t;try{let n=new OffscreenCanvas(0,0);if(n.getContext(`2d`,Il)?.measureText)return e.__canvas=n,n;t=cl.get().createCanvas()}catch{t=cl.get().createCanvas()}t.width=t.height=10,e.__canvas=t}return e.__canvas}static get _context(){return e.__context||=ll(e._canvas,Il),e.__context}static _setCanvas(t){e.__canvas=t,e.__context=void 0,e._fonts={},e._measurementCache.clear(),e._experimentalLetterSpacingSupported=void 0}},zl=[`serif`,`sans-serif`,`monospace`,`cursive`,`fantasy`,`system-ui`];function Bl(e){let t=typeof e.fontSize==`number`?`${e.fontSize}px`:e.fontSize,n=e.fontFamily;Array.isArray(e.fontFamily)||(n=e.fontFamily.split(`,`));for(let e=n.length-1;e>=0;e--){let t=n[e].trim();!/([\"\'])[^\'\"]+\1/.test(t)&&!zl.includes(t)&&(t=`"${t}"`),n[e]=t}return`${e.fontStyle} ${e.fontVariant} ${e.fontWeight} ${t} ${n.join(`,`)}`}var Vl=null,Hl=null;function Ul(e,t){Vl||(Vl=cl.get().createCanvas(256,128),Hl=ll(Vl,{willReadFrequently:!0}),Hl.globalCompositeOperation=`copy`,Hl.globalAlpha=1),(Vl.width<e||Vl.height<t)&&(Vl.width=ul(e),Vl.height=ul(t))}function Wl(e,t,n){for(let r=0,i=4*n*t;r<t;++r,i+=4)if(e[i+3]!==0)return!1;return!0}function Gl(e,t,n,r,i){let a=4*t;for(let t=r,o=r*a+4*n;t<=i;++t,o+=a)if(e[o+3]!==0)return!1;return!0}function Kl(...e){let t=e[0];t.canvas||(t={canvas:e[0],resolution:e[1]});let{canvas:n}=t,r=Math.min(t.resolution??1,1),i=t.width??n.width,a=t.height??n.height,o=t.output;if(Ul(i,a),!Hl)throw TypeError(`Failed to get canvas 2D context`);Hl.drawImage(n,0,0,i,a,0,0,i*r,a*r);let s=Hl.getImageData(0,0,i,a).data,c=0,l=0,u=i-1,d=a-1;for(;l<a&&Wl(s,i,l);)++l;if(l===a)return E.EMPTY;for(;Wl(s,i,d);)--d;for(;Gl(s,i,c,l,d);)++c;for(;Gl(s,i,u,l,d);)--u;return++u,++d,Hl.globalCompositeOperation=`source-over`,Hl.strokeRect(c,l,u-c,d-l),Hl.globalCompositeOperation=`copy`,o??=new E,o.set(c/r,l/r,(u-c)/r,(d-l)/r),o}var ql=1e5;function Jl(e,t,n,r=0,i=0,a=0){if(e.texture===I.WHITE&&!e.fill)return Yc(e.color,e.alpha??1);if(!e.fill){let n=t.createPattern(e.texture.source.resource,`repeat`),r=e.matrix.copyTo(S.shared);return r.scale(e.texture.source.pixelWidth,e.texture.source.pixelHeight),n.setTransform(r),n}else if(Qc(e.fill)){let n=e.fill,r=t.createPattern(n.texture.source.resource,`repeat`),i=n.transform.copyTo(S.shared);return i.scale(n.texture.source.pixelWidth,n.texture.source.pixelHeight),r.setTransform(i),r}else if(Zc(e.fill)){let o=e.fill,s=o.type===`linear`,c=o.textureSpace===`local`,l=1,u=1;c&&n&&(l=n.width+r,u=n.height+r);let d,f=!1;if(s){let{start:e,end:n}=o;d=t.createLinearGradient(e.x*l+i,e.y*u+a,n.x*l+i,n.y*u+a),f=Math.abs(n.x-e.x)<Math.abs((n.y-e.y)*.1)}else{let{center:e,innerRadius:n,outerCenter:r,outerRadius:s}=o;d=t.createRadialGradient(e.x*l+i,e.y*u+a,n*l,r.x*l+i,r.y*u+a,s*l)}if(f&&c&&n){let e=n.lineHeight/u;for(let t=0;t<n.lines.length;t++){let i=(t*n.lineHeight+r/2)/u;o.colorStops.forEach(t=>{let n=i+t.offset*e;n=Math.max(0,Math.min(1,n)),d.addColorStop(Math.floor(n*ql)/ql,Jc(t.color))})}}else o.colorStops.forEach(e=>{d.addColorStop(e.offset,Jc(e.color))});return d}return console.warn(`[engine2d] FillStyle not recognised`,e),`red`}var Yl=new E;function Xl(e){let t=0;for(let n=0;n<e.length;n++)e.charCodeAt(n)===32&&t++;return t}var Zl=new class{getCanvasAndContext(e){let{text:t,style:n,resolution:r=1}=e,i=n._getFinalPadding(),a=Rl.measureText(t||` `,n),o=Math.ceil(Math.ceil(Math.max(1,a.width)+i*2)*r),s=Math.ceil(Math.ceil(Math.max(1,a.height)+i*2)*r),c=dl.getOptimalCanvasAndContext(o,s);return this._renderTextToCanvas(n,i,r,c,a),{canvasAndContext:c,frame:n.trim?Kl({canvas:c.canvas,width:o,height:s,resolution:1,output:Yl}):Yl.set(0,0,o,s)}}returnCanvasAndContext(e){dl.returnCanvasAndContext(e)}_renderTextToCanvas(e,t,n,r,i){if(i.runsByLine&&i.runsByLine.length>0){this._renderTaggedTextToCanvas(i,e,t,n,r);return}let{canvas:a,context:o}=r,s=Bl(e),c=i.lines,l=i.lineHeight,u=i.lineWidths,d=i.maxLineWidth,f=i.fontProperties,p=a.height;if(o.resetTransform(),o.scale(n,n),o.textBaseline=e.textBaseline,e._stroke?.width){let t=e._stroke;o.lineWidth=t.width,o.miterLimit=t.miterLimit,o.lineJoin=t.join,o.lineCap=t.cap}o.font=s;let m,h,g=e.dropShadow?2:1,_=e.wordWrap?e.wordWrapWidth:d,v=(e._stroke?.width??0)/2,y=(l-f.fontSize)/2;l-f.fontSize<0&&(y=0);for(let a=0;a<g;++a){let s=e.dropShadow&&a===0,d=s?Math.ceil(Math.max(1,p)+t*2):0,g=d*n;if(s)this._setupDropShadow(o,e,n,g);else{let n=e._gradientBounds,r=e._gradientOffset;if(n){let a={width:n.width,height:n.height,lineHeight:n.height,lines:i.lines};this._setFillAndStrokeStyles(o,e,a,t,v,r?.x??0,r?.y??0)}else r?this._setFillAndStrokeStyles(o,e,i,t,v,r.x,r.y):this._setFillAndStrokeStyles(o,e,i,t,v);o.shadowColor=`rgba(0,0,0,0)`}for(let n=0;n<c.length;n++){m=v,h=v+n*l+f.ascent+y,m+=this._getAlignmentOffset(u[n],_,e.align);let i=0;if(e.align===`justify`&&e.wordWrap&&n<c.length-1){let e=Xl(c[n]);e>0&&(i=(_-u[n])/e)}e._stroke?.width&&this._drawLetterSpacing(c[n],e,r,m+t,h+t-d,!0,i),e._fill!==void 0&&this._drawLetterSpacing(c[n],e,r,m+t,h+t-d,!1,i)}}}_renderTaggedTextToCanvas(e,t,n,r,i){let{canvas:a,context:o}=i,{lineWidths:s,maxLineWidth:c,hasDropShadow:l}=e,u=e.runsByLine,d=e.lineAscents,f=e.lineHeights,p=a.height;o.resetTransform(),o.scale(r,r),o.textBaseline=t.textBaseline;let m=l?2:1,h=t.wordWrap?t.wordWrapWidth:c,g=t._stroke?.width??0;for(let e of u)for(let t of e){let e=t.style._stroke?.width??0;e>g&&(g=e)}let _=g/2,v=[];for(let e=0;e<u.length;e++){let t=u[e],n=[];for(let e of t){let t=Bl(e.style);o.font=t,n.push({width:Rl._measureText(e.text,e.style.letterSpacing,o),font:t})}v.push(n)}for(let e=0;e<m;++e){let a=l&&e===0,c=a?Math.ceil(Math.max(1,p)+n*2):0,m=c*r;a||(o.shadowColor=`rgba(0,0,0,0)`);let g=_;for(let e=0;e<u.length;e++){let l=u[e],p=s[e],y=d[e],b=f[e],x=v[e],S=_;S+=this._getAlignmentOffset(p,h,t.align);let C=0;if(t.align===`justify`&&t.wordWrap&&e<u.length-1){let e=0;for(let t of l)e+=Xl(t.text);e>0&&(C=(h-p)/e)}let w=g+y,T=S+n;for(let e=0;e<l.length;e++){let t=l[e],{width:s,font:u}=x[e];if(o.font=u,o.textBaseline=t.style.textBaseline,t.style._stroke?.width){let e=t.style._stroke;if(o.lineWidth=e.width,o.miterLimit=e.miterLimit,o.lineJoin=e.join,o.lineCap=e.cap,a)if(t.style.dropShadow)this._setupDropShadow(o,t.style,r,m);else{let e=Xl(t.text);T+=s+e*C;continue}else{let r=Rl.measureFont(u),i=t.style.lineHeight||r.fontSize;o.strokeStyle=Jl(e,o,{width:s,height:i,lineHeight:i,lines:[t.text]},n*2,T-n,g)}this._drawLetterSpacing(t.text,t.style,i,T,w+n-c,!0,C)}let d=Xl(t.text);T+=s+d*C}T=S+n;for(let e=0;e<l.length;e++){let t=l[e],{width:s,font:u}=x[e];if(o.font=u,o.textBaseline=t.style.textBaseline,t.style._fill!==void 0){if(a)if(t.style.dropShadow)this._setupDropShadow(o,t.style,r,m);else{let e=Xl(t.text);T+=s+e*C;continue}else{let e=Rl.measureFont(u),r=t.style.lineHeight||e.fontSize,i={width:s,height:r,lineHeight:r,lines:[t.text]};o.fillStyle=Jl(t.style._fill,o,i,n*2,T-n,g)}this._drawLetterSpacing(t.text,t.style,i,T,w+n-c,!1,C)}let d=Xl(t.text);T+=s+d*C}g+=b}}}_setFillAndStrokeStyles(e,t,n,r,i,a=0,o=0){if(e.fillStyle=t._fill?Jl(t._fill,e,n,r*2,a,o):null,t._stroke?.width){let s=i+r*2;e.strokeStyle=Jl(t._stroke,e,n,s,a,o)}}_setupDropShadow(e,t,n,r){e.fillStyle=`black`,e.strokeStyle=`black`;let i=t.dropShadow,a=i.color,o=i.alpha;e.shadowColor=Xc(a,o);let s=i.blur*n,c=i.distance*n;e.shadowBlur=s,e.shadowOffsetX=Math.cos(i.angle)*c,e.shadowOffsetY=Math.sin(i.angle)*c+r}_getAlignmentOffset(e,t,n){return n===`right`?t-e:n===`center`?(t-e)/2:0}_drawLetterSpacing(e,t,n,r,i,a=!1,o=0){let{context:s}=n,c=t.letterSpacing,l=!1;if(Rl.experimentalLetterSpacingSupported&&(Rl.experimentalLetterSpacing?(s.letterSpacing=`${c}px`,s.textLetterSpacing=`${c}px`,l=!0):(s.letterSpacing=`0px`,s.textLetterSpacing=`0px`)),(c===0||l)&&o===0){a?s.strokeText(e,r,i):s.fillText(e,r,i);return}if(o!==0&&(c===0||l)){let t=e.split(` `),n=r,c=s.measureText(` `).width;for(let e=0;e<t.length;e++)a?s.strokeText(t[e],n,i):s.fillText(t[e],n,i),n+=s.measureText(t[e]).width+c+o;return}let u=r,d=Rl.graphemeSegmenter(e),f=s.measureText(e).width,p=0;for(let e=0;e<d.length;++e){let t=d[e];a?s.strokeText(t,u,i):s.fillText(t,u,i);let n=``;for(let t=e+1;t<d.length;++t)n+=d[t];p=s.measureText(n).width,u+=f-p+c,t===` `&&(u+=o),f=p}}},Ql=class e extends _{static{this.defaultDropShadow={alpha:1,angle:Math.PI/6,blur:0,color:`black`,distance:5}}static{this.defaultTextStyle={align:`left`,breakWords:!1,dropShadow:null,fill:`black`,fontFamily:`Arial`,fontSize:26,fontStyle:`normal`,fontVariant:`normal`,fontWeight:`normal`,leading:0,letterSpacing:0,lineHeight:0,padding:0,stroke:null,textBaseline:`alphabetic`,trim:!1,whiteSpace:`pre`,wordWrap:!1,wordWrapWidth:100}}constructor(t={}){super(),this.uid=F(`textStyle`),this._tick=0,this._cachedFontString=null,$l(t),t instanceof e&&(t=t._toObject());let n={...e.defaultTextStyle,...t};for(let e in n)this[e]=n[e];this._tagStyles=t.tagStyles??void 0,this.update(),this._tick=0}get align(){return this._align}set align(e){this._align!==e&&(this._align=e,this.update())}get breakWords(){return this._breakWords}set breakWords(e){this._breakWords!==e&&(this._breakWords=e,this.update())}get dropShadow(){return this._dropShadow}set dropShadow(t){this._dropShadow!==t&&(typeof t==`object`&&t?this._dropShadow=this._createProxy({...e.defaultDropShadow,...t}):this._dropShadow=t?this._createProxy({...e.defaultDropShadow}):null,this.update())}get fontFamily(){return this._fontFamily}set fontFamily(e){this._fontFamily!==e&&(this._fontFamily=e,this.update())}get fontSize(){return this._fontSize}set fontSize(e){this._fontSize!==e&&(typeof e==`string`?this._fontSize=parseInt(e,10):this._fontSize=e,this.update())}get fontStyle(){return this._fontStyle}set fontStyle(e){this._fontStyle!==e&&(this._fontStyle=e.toLowerCase(),this.update())}get fontVariant(){return this._fontVariant}set fontVariant(e){this._fontVariant!==e&&(this._fontVariant=e,this.update())}get fontWeight(){return this._fontWeight}set fontWeight(e){this._fontWeight!==e&&(this._fontWeight=e,this.update())}get leading(){return this._leading}set leading(e){this._leading!==e&&(this._leading=e,this.update())}get letterSpacing(){return this._letterSpacing}set letterSpacing(e){this._letterSpacing!==e&&(this._letterSpacing=e,this.update())}get lineHeight(){return this._lineHeight}set lineHeight(e){this._lineHeight!==e&&(this._lineHeight=e,this.update())}get padding(){return this._padding}set padding(e){this._padding!==e&&(this._padding=e,this.update())}get filters(){return this._filters}set filters(e){this._filters!==e&&(this._filters=Object.freeze(e),this.update())}get trim(){return this._trim}set trim(e){this._trim!==e&&(this._trim=e,this.update())}get textBaseline(){return this._textBaseline}set textBaseline(e){this._textBaseline!==e&&(this._textBaseline=e,this.update())}get whiteSpace(){return this._whiteSpace}set whiteSpace(e){this._whiteSpace!==e&&(this._whiteSpace=e,this.update())}get wordWrap(){return this._wordWrap}set wordWrap(e){this._wordWrap!==e&&(this._wordWrap=e,this.update())}get wordWrapWidth(){return this._wordWrapWidth}set wordWrapWidth(e){this._wordWrapWidth!==e&&(this._wordWrapWidth=e,this.update())}get fill(){return this._originalFill}set fill(e){e!==this._originalFill&&(this._originalFill=e,this._isFillStyle(e)&&(this._originalFill=this._createProxy({...zc,...e},()=>{this._fill=al({...this._originalFill},zc)})),this._fill=al(e===0?`black`:e,zc),this.update())}get stroke(){return this._originalStroke}set stroke(e){e!==this._originalStroke&&(this._originalStroke=e,this._isFillStyle(e)&&(this._originalStroke=this._createProxy({...Bc,...e},()=>{this._stroke=ol({...this._originalStroke},Bc)})),this._stroke=ol(e,Bc),this.update())}get tagStyles(){return this._tagStyles}set tagStyles(e){this._tagStyles!==e&&(this._tagStyles=e??void 0,this.update())}update(){this._tick++,this._cachedFontString=null,this.emit(`update`,this)}reset(){let t=e.defaultTextStyle;for(let e in t)this[e]=t[e]}assign(e){for(let t in e)this[t]=e[t];return this}get styleKey(){return`${this.uid}-${this._tick}`}get _fontString(){return this._cachedFontString===null&&(this._cachedFontString=Bl(this)),this._cachedFontString}_toObject(){return{align:this.align,breakWords:this.breakWords,dropShadow:this._dropShadow?{...this._dropShadow}:null,fill:this._fill?{...this._fill}:void 0,fontFamily:this.fontFamily,fontSize:this.fontSize,fontStyle:this.fontStyle,fontVariant:this.fontVariant,fontWeight:this.fontWeight,leading:this.leading,letterSpacing:this.letterSpacing,lineHeight:this.lineHeight,padding:this.padding,stroke:this._stroke?{...this._stroke}:void 0,textBaseline:this.textBaseline,trim:this.trim,whiteSpace:this.whiteSpace,wordWrap:this.wordWrap,wordWrapWidth:this.wordWrapWidth,filters:this._filters?[...this._filters]:void 0,tagStyles:this._tagStyles?{...this._tagStyles}:void 0}}clone(){return new e(this._toObject())}_getFinalPadding(){let e=0;if(this._filters)for(let t=0;t<this._filters.length;t++)e+=this._filters[t].padding;return Math.max(this._padding,e)}destroy(e=!1){if(this.removeAllListeners(),typeof e==`boolean`?e:e?.texture){let t=typeof e==`boolean`?e:e?.textureSource,n=this._fill,r=this._originalFill,i=this._stroke,a=this._originalStroke;n?.texture&&n.texture.destroy(t),r?.texture&&r.texture.destroy(t),i?.texture&&i.texture.destroy(t),a?.texture&&a.texture.destroy(t)}this._fill=null,this._stroke=null,this.dropShadow=null,this._originalStroke=null,this._originalFill=null}_createProxy(e,t){return new Proxy(e,{set:(e,n,r)=>e[n]===r?!0:(e[n]=r,t?.(n,r),this.update(),!0)})}_isFillStyle(e){return(e??null)!==null&&!(Vc(e)||Zc(e)||Qc(e))}};function $l(e){let t=e;if(typeof t.dropShadow==`boolean`&&t.dropShadow){let n=Ql.defaultDropShadow;e.dropShadow={alpha:t.dropShadowAlpha??n.alpha,angle:t.dropShadowAngle??n.angle,blur:t.dropShadowBlur??n.blur,color:t.dropShadowColor??n.color,distance:t.dropShadowDistance??n.distance}}if(t.strokeThickness!==void 0){let n=t.stroke,r={};if(Vc(n))r.color=n;else if(Zc(n)||Qc(n))r.fill=n;else if(Object.hasOwnProperty.call(n,`color`)||Object.hasOwnProperty.call(n,`fill`))r=n;else throw Error(`Invalid stroke value.`);e.stroke={...r,width:t.strokeThickness}}if(Array.isArray(t.fillGradientStops))throw!Array.isArray(t.fill)||t.fill.length===0?Error(`Invalid fill value. Expected an array of colors for gradient fill.`):Error(`[engine2d] TextStyle: v7 的 fillGradientStops 写法不支持,请用 v8 的 FillGradient`)}var eu=new WeakMap,tu=new ie;function nu(e,t,n,r,i=!1){let a=eu.get(e);(!a||a.destroyed||!a.source||a.source.destroyed)&&(a=new I({source:new fe({resource:e,resolution:1,autoGenerateMipmaps:i,label:`text`}),frame:new E(0,0,t/r,n/r),label:`text`}),eu.set(e,a));let o=a.source;return o.resolution=r,o.style=tu,o.alphaMode=`premultiply-alpha-on-upload`,o.autoGenerateMipmaps=i,a.frame.x=0,a.frame.y=0,a.frame.width=t/r,a.frame.height=n/r,o.update(),a.updateUvs(),a}function ru(e){let t=e.source?.resource;return!t||eu.get(t)!==e?null:t}var iu=!1;new class{constructor(){this.resolution=1,this.filterHook=null,this._activeTextures={},this._filteredTextures=new WeakSet}getTexture(e,t,n,r){typeof e==`string`&&(e={text:e,style:n,resolution:t}),e.style instanceof Ql||(e.style=new Ql(e.style)),e.textureStyle instanceof ie||(e.textureStyle=e.textureStyle?new ie(e.textureStyle):tu),typeof e.text!=`string`&&(e.text=e.text.toString());let{text:i,textureStyle:a,autoGenerateMipmaps:o}=e,s=e.style,c=e.resolution??this.resolution,{frame:l,canvasAndContext:u}=Zl.getCanvasAndContext({text:i,style:s,resolution:c}),d=nu(u.canvas,l.width,l.height,c,o);if(a&&(d.source.style=a),s.trim&&(l.pad(s.padding),d.frame.copyFrom(l),d.frame.scale(1/c),d.updateUvs()),s.filters&&s.filters.length>0){if(this.filterHook){let e=this.filterHook.apply(d,s.filters);return this.returnTexture(d),this._filteredTextures.add(e),e}iu||(iu=!0,console.warn(`[engine2d] TextStyle.filters:渲染核心尚未接入文字滤镜,按无滤镜绘制`))}return d}returnTexture(e){if(this._filteredTextures.has(e)){this._filteredTextures.delete(e),this.filterHook?.release(e);return}let t=ru(e);if(t){let e=ll(t);e&&Zl.returnCanvasAndContext({canvas:t,context:e})}}getManagedTexture(e,t=this.resolution){e._resolution=e._autoResolution?t:e.resolution;let n=e.styleKey;if(this._activeTextures[n])return this._increaseReferenceCount(n),this._activeTextures[n].texture;let r=this.getTexture({text:e.text,style:e.style,resolution:e._resolution,textureStyle:e.textureStyle,autoGenerateMipmaps:e.autoGenerateMipmaps});return this._activeTextures[n]={texture:r,usageCount:1},r}decreaseReferenceCount(e){let t=this._activeTextures[e];t&&(t.usageCount--,t.usageCount===0&&(this.returnTexture(t.texture),this._activeTextures[e]=null))}getReferenceCount(e){return this._activeTextures[e]?.usageCount??0}_increaseReferenceCount(e){this._activeTextures[e].usageCount++}destroy(){for(let e in this._activeTextures)this._activeTextures[e]&&this.returnTexture(this._activeTextures[e].texture);this._activeTextures={}}};var au=`http://www.w3.org/2000/svg`,ou=`http://www.w3.org/1999/xhtml`,su=class{constructor(){this.svgRoot=document.createElementNS(au,`svg`),this.foreignObject=document.createElementNS(au,`foreignObject`),this.domElement=document.createElementNS(ou,`div`),this.styleElement=document.createElementNS(ou,`style`);let{foreignObject:e,svgRoot:t,styleElement:n,domElement:r}=this;e.setAttribute(`width`,`10000`),e.setAttribute(`height`,`10000`),e.style.overflow=`hidden`,t.appendChild(e),e.appendChild(n),e.appendChild(r),this.image=cl.get().createImage()}destroy(){this.svgRoot.remove(),this.foreignObject.remove(),this.styleElement.remove(),this.domElement.remove(),this.image.src=``,this.image.remove(),this.svgRoot=null,this.foreignObject=null,this.styleElement=null,this.domElement=null,this.image=null}};function cu(e,t){let n=t.fontFamily,r=[],i={},a=e.match(/font-family:([^;"\s]+)/g);function o(e){i[e]||(r.push(e),i[e]=!0)}if(Array.isArray(n))for(let e=0;e<n.length;e++)o(n[e]);else o(n);a&&a.forEach(e=>{o(e.split(`:`)[1].trim())});for(let e in t.tagStyles){let n=t.tagStyles[e].fontFamily;o(n)}return r}async function lu(e){let t=await(await cl.get().fetch(e)).blob(),n=new FileReader;return await new Promise((e,r)=>{n.onloadend=()=>e(n.result),n.onerror=r,n.readAsDataURL(t)})}async function uu(e,t){let n=await lu(t);return`@font-face {
        font-family: "${e.fontFamily}";
        font-weight: ${e.fontWeight};
        font-style: ${e.fontStyle};
        src: url('${n}');
    }`}var du=()=>void 0,fu=new Map;async function pu(e){let t=e.filter(e=>du(`${e}-and-url`)!==void 0).map(e=>{if(!fu.has(e)){let{entries:t}=du(`${e}-and-url`),n=[];t.forEach(t=>{let r=t.url,i=t.faces.map(e=>({weight:e.weight,style:e.style}));n.push(...i.map(t=>uu({fontWeight:t.weight,fontStyle:t.style,fontFamily:e},r)))}),fu.set(e,Promise.all(n).then(e=>e.join(`
`)))}return fu.get(e)});return(await Promise.all(t)).join(`
`)}function mu(e,t,n,r,i){let{domElement:a,styleElement:o,svgRoot:s}=i;a.innerHTML=`<style>${t.cssStyle}</style><div style='padding:0;'>${e}</div>`,a.setAttribute(`style`,`transform: scale(${n});transform-origin: top left; display: inline-block`),o.textContent=r;let{width:c,height:l}=i.image;return s.setAttribute(`width`,c.toString()),s.setAttribute(`height`,l.toString()),new XMLSerializer().serializeToString(s)}function hu(e,t){let n=dl.getOptimalCanvasAndContext(e.width/t|0,e.height/t|0,t),{context:r}=n;return r.clearRect(0,0,e.width,e.height),r.drawImage(e,0,0),n}function gu(e,t,n){return new Promise(async r=>{n&&await new Promise(e=>setTimeout(e,100)),e.onload=()=>{r()},e.src=`data:image/svg+xml;charset=utf8,${encodeURIComponent(t)}`,e.crossOrigin=`anonymous`})}var _u;function vu(e,t,n,r){r||=_u||=new su;let{domElement:i,styleElement:a,svgRoot:o}=r;i.innerHTML=`<style>${t.cssStyle};</style><div style='padding:0'>${e}</div>`,i.setAttribute(`style`,`transform-origin: top left; display: inline-block`),n&&(a.textContent=n),document.body.appendChild(o);let s=i.scrollWidth,c=i.scrollHeight;if(o.remove(),t.dropShadow){let{distance:e,angle:n,blur:r}=t.dropShadow,i=Math.abs(Math.round(Math.cos(n)*e)),a=Math.abs(Math.round(Math.sin(n)*e));s+=i+r,c+=a+r}let l=t.padding*2;return{width:s-l,height:c-l}}function yu(){let{userAgent:e}=cl.get().getNavigator();return/^((?!chrome|android).)*safari/i.test(e)}var bu=[];new class{constructor(){this._activeTextures={}}getTexture(e){return this.getTexturePromise(e)}getManagedTexture(e){let t=e.styleKey;if(this._activeTextures[t])return this._increaseReferenceCount(t),this._activeTextures[t].promise;let n=this._buildTexturePromise(e).then(e=>(this._activeTextures[t].texture=e,e));return this._activeTextures[t]={texture:null,promise:n,usageCount:1},n}getReferenceCount(e){return this._activeTextures[e]?.usageCount??null}_increaseReferenceCount(e){this._activeTextures[e].usageCount++}decreaseReferenceCount(e){let t=this._activeTextures[e];t&&(t.usageCount--,t.usageCount===0&&(t.texture?this._cleanUp(t.texture):t.promise.then(e=>{t.texture=e,this._cleanUp(t.texture)}).catch(()=>{console.warn(`HTMLTextSystem: Failed to clean texture`)}),this._activeTextures[e]=null))}getTexturePromise(e){return this._buildTexturePromise(e)}async _buildTexturePromise(e){let{text:t,style:n,resolution:r,textureStyle:i,autoGenerateMipmaps:a}=e,o=bu.pop()??new su,s=cu(t,n),c=await pu(s),l=vu(t,n,c,o),u=Math.ceil(Math.ceil(Math.max(1,l.width)+n.padding*2)*r),d=Math.ceil(Math.ceil(Math.max(1,l.height)+n.padding*2)*r),f=o.image;f.width=(u|0)+2,f.height=(d|0)+2,await gu(f,mu(t,n,r,c,o),yu()&&s.length>0);let p=nu(hu(f,r).canvas,f.width-2,f.height-2,r,a);return i&&(p.source.style=i instanceof ie?i:new ie(i)),bu.push(o),p}returnTexturePromise(e){e.then(e=>{this._cleanUp(e)}).catch(()=>{console.warn(`HTMLTextSystem: Failed to clean texture`)})}_cleanUp(e){let t=ru(e);t&&dl.returnCanvasAndContext({canvas:t,context:ll(t)})}destroy(){for(let e in this._activeTextures)this._activeTextures[e]&&this.returnTexturePromise(this._activeTextures[e].promise);this._activeTextures={}}};function xu(e){return{cols:e.cols,rows:e.rows,slotCount:e.atlasFrames?.length??0}}function Su(e,t){return t<0?!e:e}function Cu(e,t){let n=t.depthScale>0&&Number.isFinite(t.depthScale)?t.depthScale:1,r=t.facing,i=typeof t.anchorX==`number`&&Number.isFinite(t.anchorX)?t.anchorX:.5,a=typeof t.anchorY==`number`&&Number.isFinite(t.anchorY)?t.anchorY:1;return{x:(e.x-i)*t.worldWidth*n*r,y:t.visualLiftY+(e.y-a)*t.worldHeight*n,angleDeg:(e.angle??0)*r,front:Su(e.front!==!1,r*(t.hostMirrorX!==void 0&&t.hostMirrorX<0?-1:1)),frame:typeof e.frame==`number`?e.frame:null,scale:n,facing:r}}function wu(e){return e<0?0:e>1?1:e}function Tu(e,t,n,r){let i=t.scale??1,a=t.mirrorWithHost===!1?1:e.facing,o=(t.rotationOffsetDeg??0)*e.facing,s=i*e.scale*a,c=i*e.scale,l=(e.angleDeg+o)*Math.PI/180,u=(wu(n)-wu(t.anchorX??.5))*t.texW*s,d=(wu(r)-wu(t.anchorY??.5))*t.texH*c,f=Math.cos(l),p=Math.sin(l);return{x:e.x+u*f-d*p,y:e.y+u*p+d*f}}Object.freeze({indirectFactor:1,directFactor:1,totalFactor:1});var Eu=`// ============================================================================
// 角色着色核心 —— 唯一真相源（single source of truth）。
//
// 游戏（CharacterShadingFilter 的滤镜、CharacterLitSprite 的 sprite 网格、粒子受光）与灯光实验室
// （页面画的就是游戏本体）**共用这一份**：不单独拼，由 CHAR_LIGHT_COMMON_WGSL（charLightCommon.wgsl
// 的 CLC 段）在 __CHAR_SHADE_CORE_WGSL__ 那一行原样注入。任何角色着色迭代（尤其 E 的颜色 / 明暗分离）
// 只改此文件——**禁止在任一处内联重写这段逻辑**，否则实验室预览与游戏漂移、在实验室调出的参数到游戏里就是错的。
// 与 master（GLSL 版 charShadeCore.glsl）逐像素一致由 tools/render_parity 的「光照片段 / 着色核心」用例钉住。
//
// 依赖：调用方模块里已定义 srgb2lin()（CLC 段自带）。本段不读任何绑定。
// ============================================================================

// E 分解 + albedo × E。
//   albSrgb  角色 albedo（sRGB，直通图集像素；sprite 本身是着色后的 color）
//   E        场景辐照度（RGB，probe / RT gather；已含太阳等累加）
//   eChroma  E 色度权重：0 = 只借场景明暗（luma）、角色保留自己颜色不被场景色染；1 = 完整彩色 E
//   beta     曝光（已 pow，即 2^β）
// 返回：**线性域** col（未 lin2srgb、未乘实验室 pgain、未 clamp——由各调用方按自身上下文处理）。
fn shadeCharacterLinear(albSrgb: vec3<f32>, EIn: vec3<f32>, eChroma: f32, beta: f32) -> vec3<f32> {
    let lumaE = dot(EIn, vec3<f32>(0.2126, 0.7152, 0.0722));
    let E = mix(vec3<f32>(lumaE), EIn, eChroma);   // sprite 缺的是明暗、颜色自带 → 默认只借明暗
    return srgb2lin(albSrgb) * E / 3.14159265 * beta;
}

// factor 全为 1 时与背景 albedo * lampE 同尺。旧曝光等价折入场景 totalFactor。
// 色度只由各自路径传入；粒子不再读取角色的运行时调色覆盖。
fn shadeEntityLinear(albSrgb: vec3<f32>, indirectE: vec3<f32>, directE: vec3<f32>,
                     indirectFactor: f32, directFactor: f32, totalFactor: f32,
                     eChroma: f32) -> vec3<f32> {
    let E = indirectE * indirectFactor + directE * directFactor;
    let luma = dot(E, vec3<f32>(0.2126, 0.7152, 0.0722));
    return srgb2lin(albSrgb) * mix(vec3<f32>(luma), E, eChroma) * totalFactor;
}
`,Du=`// ============================================================================
// 角色照明公共块（CHAR_LIGHT_COMMON）—— 唯一一份
//
// 角色逐像素照明的公共数学：probe 查表（shY / ambIrr / octaEnc / probeE …）、skyao 天穹遮蔽、
// 体素卷三线性、RT gather（uMode 0 诊断档）与注入的着色核心 charShadeCore.wgsl。角色两条宿主
// （CharacterShadingFilter 的滤镜、CharacterLitSprite 的 sprite 网格）、粒子受光与场景光照 pass 的
// 调试视图拼的都是这一份——同一份数学只写一遍（与实验室 LIGHT_FNS 同一纪律）。
// 数学约定：probe 查表吃 q 空间法线 nQ；skyao 走 det=+1 的 uSkyaoM；两个 M 不许混（坐标卡）。
// 与 master（GLSL 版，住在 CharacterShadingFilter.ts 的 FRAG 里）逐像素一致由 tools/render_parity 的
// 「光照片段 /」「角色受光 /」用例钉住，改了必须重跑对照。
//
// 【三份导出（CharacterShadingFilter.ts）】
//   · CHAR_LIGHT_COMMON_WGSL = 本文件 __CLC_*__ 之间，再把 __CHAR_SHADE_CORE_WGSL__ 那一行换成
//     charShadeCore.wgsl。
//   · PROBE_SAMPLING_WGSL / SKYAO_SAMPLING_WGSL = 其中的两段切片（场景光照 pass 的 GI 体 /
//     skyao 体调试视图单独拼这两段，与角色吃同一份采样数学）。
//   同一模块里每段只许拼一次（WGSL 没有预处理器，重复定义编译失败）：拼了整个 CLC 就不要再拼
//   PROBE / SKYAO。
//
// 【为什么块里不读 uniform】WGSL 的 uniform 必须活在宿主的 uniform 结构里，而同一批量在各宿主里
//   分在不同的组：角色网格是 sceneShade + frameShade，粒子是 sceneShade + 自己的 frameShade，场景光照 pass
//   全在 sceneLight 一组里。块里写死任何组名 / 绑定都会把这些分叉焊死。所以：
//
//   ① 块里的函数**一个绑定都不读**：uniform 量打成下面几个值结构当形参传，纹理也当形参传
//      （只用 textureLoad，不需要采样器）。形参顺序统一为：几何实参 → 参数结构 → 纹理。
//   ② 宿主从自己的 uniform 组里**按字段名逐个赋值**建结构（别用位置构造式：一串 f32 位置
//      写错不报错），在 main 开头建一次、往下传：
//
//        var pp: ClcProbe;
//        pp.uM = sceneShade.uM;  pp.uWMin = sceneShade.uWMin;  pp.uWScale = sceneShade.uWScale;
//        pp.uPN = sceneShade.uPN;  pp.uProbeT = sceneShade.uProbeT;  pp.uShK = sceneShade.uShK;
//        pp.uBinOb = sceneShade.uBinOb;  pp.uFold = frameShade.uFold;  pp.uAmbSH = sceneShade.uAmbSH;
//        pp.uMode = frameShade.uMode;  pp.uAmbStrength = frameShade.uAmbStrength;
//        let E = probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid);
//
//      结构的字段名 = 宿主 JS uniform 组里的同名成员；某宿主的 JS uniform 组若恰好按同名同序只装
//      这些量，也可以直接把组绑成这个结构类型（绑定变量名 = resources 键名）。
//   ③ ClcRt 带两个 48 元 vec4 数组，gatherRT 按 ptr<function, ClcRt> 收（按值传会整份拷贝；
//      宿主只在 uMode == 0 那一支里 var 一份）。
//   ④ gatherRT 的随机旋转取片元坐标：由调用方把入口的位置内建量 .xy 传进来（离屏目标上与 master 的
//      gl_FragCoord 行序一致，对照用例钉着）。
//   ⑤ 只有宿主 main 读的量（uWorkSize / uWorldToWork / uCal / uCosT / uSinT / uBeta / uGiStrength /
//      三个 factor / uFixedNQ / uEChecker / uBulge / uFlatten / uShowN / uEOnly / uSun* / uEChroma /
//      uAO* / uSkyaoBlend）块里不管，宿主在自己的 uniform 结构里声明、main 里直接读。
//
// 【写法约束（与 master 的 GLSL 版数值不变）】
//   · mod(x, y) 写成 x − y·floor(x/y)（GLSL 定义式；WGSL 的 % 向零截断，负数不同）。
//   · 三元式一律写成 if/else（不用 select：select 两边都求值）；按布尔向量逐分量挑才写
//     select(a, b, bvec)（boxEnter，本来就两边都算）。
//   · 形参不可写：改写形参的地方用局部量；of 在 WGSL 是保留字，改叫 ofr。
//   · 字面量与字面量的算术写成 f32 后缀，常量折叠在 32 位里做。
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件注释里不许出现
//   「at 号 + group / binding + 括号」字样；struct 体内不许写注释（注释里的「名: 类型」会被当成成员）。
// ============================================================================

//__CLC_BEGIN__
fn srgb2lin(c: vec3<f32>) -> vec3<f32> { return mix(c / 12.92, pow((c + .055) / 1.055, vec3<f32>(2.4)), step(vec3<f32>(.04045), c)); }
fn lin2srgb(cIn: vec3<f32>) -> vec3<f32> { let c = max(cIn, vec3<f32>(0.)); return mix(c * 12.92, 1.055 * pow(c, vec3<f32>(1.f / 2.4f)) - .055, step(vec3<f32>(.0031308), c)); }
//__CHAR_SHADE_CORE_WGSL__
//__PROBE_SAMPLING_BEGIN__
// probe 采样自足块（shY / ambIrr / octaEnc / probeE …）。场景光照 pass 的「GI体」调试视图拼接
// 同一份（PROBE_SAMPLING_WGSL），与角色吃同一套采样数学 —— 改这里 = 两边同时改。
// probe 纹理（uPL1 / uPL2 / uPBin / uValid）由各宿主自己声明、当形参传进来。ClcProbe 字段：
//   uM = q → 世界（lighting.json world.M，det=−1，只给 probe 查表）；uWMin / uWScale / uPN = probe 网格
//   （uPN 是网格维度，float）；uProbeT = 图集平铺每行多少颗（P > 8192 行时 GPU 纹理高度爆上限）；
//   uShK = l2 图集每颗的球谐系数数 9（L2）/ 25（L4），来自 lighting.json probes.sh_k；
//   uBinOb = 八面体边长 8（64 方向）/ 16（256 方向），来自 probes.bin_ob；
//   uFold = A7 摄像机侧折叠（RT 逐射线折；probe 折查询法线，见 probeQueryN）；
//   uAmbSH / uAmbStrength = miss 环境光的球谐与强度（J̄ 系数）；uMode = 0 RT / 1 L1 / 2 L2 / 3 BIN。
struct ClcProbe {
    uM: mat3x3<f32>,
    uWMin: vec3<f32>,
    uWScale: vec3<f32>,
    uPN: vec3<f32>,
    uProbeT: f32,
    uShK: f32,
    uBinOb: f32,
    uFold: f32,
    uAmbSH: array<vec3<f32>, 9>,
    uMode: f32,
    uAmbStrength: f32,
}

// 实球谐基 l<=4（k=0..24），与 estimators.sh_basis 逐行同值同序（改一处必须改两处；
// python 侧有 Gram 矩阵测试钉常数）。L4 的由来：贴壳 probe 99% 能量在下半球，
// 朝上真值只占 0.6~1.8%，L2 在这个谷底只给 0.30（0~0.80），L4 0.79，L6 0.92。
fn shY(k: i32, n: vec3<f32>) -> f32 {
    if (k == 0) { return .282095; }
    if (k == 1) { return .488603 * n.y; }  if (k == 2) { return .488603 * n.z; }  if (k == 3) { return .488603 * n.x; }
    if (k == 4) { return 1.092548 * n.x * n.y; } if (k == 5) { return 1.092548 * n.y * n.z; }
    if (k == 6) { return .315392 * (3. * n.z * n.z - 1.); }
    if (k == 7) { return 1.092548 * n.x * n.z; } if (k == 8) { return .546274 * (n.x * n.x - n.y * n.y); }
    let x2 = n.x * n.x;
    let y2 = n.y * n.y;
    let z2 = n.z * n.z;
    if (k == 9)  { return .590044 * n.y * (3. * x2 - y2); }
    if (k == 10) { return 2.890611 * n.x * n.y * n.z; }
    if (k == 11) { return .457046 * n.y * (5. * z2 - 1.); }
    if (k == 12) { return .373176 * n.z * (5. * z2 - 3.); }
    if (k == 13) { return .457046 * n.x * (5. * z2 - 1.); }
    if (k == 14) { return 1.445306 * n.z * (x2 - y2); }
    if (k == 15) { return .590044 * n.x * (x2 - 3. * y2); }
    if (k == 16) { return 2.503343 * n.x * n.y * (x2 - y2); }
    if (k == 17) { return 1.770131 * n.y * n.z * (3. * x2 - y2); }
    if (k == 18) { return .946175 * n.x * n.y * (7. * z2 - 1.); }
    if (k == 19) { return .669047 * n.y * n.z * (7. * z2 - 3.); }
    if (k == 20) { return .105786 * (35. * z2 * z2 - 30. * z2 + 3.); }
    if (k == 21) { return .669047 * n.x * n.z * (7. * z2 - 3.); }
    if (k == 22) { return .473087 * (x2 - y2) * (7. * z2 - 1.); }
    if (k == 23) { return 1.770131 * n.x * n.z * (x2 - 3. * y2); }
    return .625836 * (x2 * x2 - 6. * x2 * y2 + y2 * y2);
}
fn ambIrr(n: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    var A = array<f32, 9>(3.141593, 2.094395, 2.094395, 2.094395, .785398, .785398, .785398, .785398, .785398);
    var E = vec3<f32>(0.);
    for (var k = 0; k < 9; k++) { E += P.uAmbSH[k] * A[k] * shY(k, n); }
    return max(E, vec3<f32>(0.)) * P.uAmbStrength;
}
// 八面体图的接缝环绕：越过边的 texel = 该边内侧沿边镜像的 texel（先 x 后 y，角落落到对角）。
// ⚠ 缺这一步就会把边界抽头 clamp 到内部、取到球面上无关的方向：地板法线在 q 空间
// 正好压在接缝上（n.x≈0、n.z<0），0.3° 抖动就让取值跳 1.77x（破屋平地板硬边斑驳，
// 2026-09-02）。与 estimators.octa_wrap 同一套规则，改一处必须改两处。
fn octaIdx(cIn: vec2<i32>, ob: i32) -> i32 {
    var c = cIn;
    if (c.x < 0) { c.x = 0; c.y = ob - 1 - c.y; } else if (c.x > ob - 1) { c.x = ob - 1; c.y = ob - 1 - c.y; }
    if (c.y < 0) { c.y = 0; c.x = ob - 1 - c.x; } else if (c.y > ob - 1) { c.y = ob - 1; c.x = ob - 1 - c.x; }
    return c.y * ob + c.x;
}
fn octaEnc(nIn: vec3<f32>) -> vec2<f32> {
    let n = nIn / (abs(nIn.x) + abs(nIn.y) + abs(nIn.z));
    var p = n.xy;
    if (n.z < 0.) {
        var sx = -1.;
        if (n.x >= 0.) { sx = 1.; }
        var sy = -1.;
        if (n.y >= 0.) { sy = 1.; }
        p = (1. - abs(n.yx)) * vec2<f32>(sx, sy);
    }
    return p * .5 + .5;
}
// q → probe 网格连续坐标。单独立名是为了调试视图（SceneLightingPass uDebug==9 的
// 棋盘格）能用**与采样一模一样**的映射画出 cell 结构 —— 复制一份迟早漂。
fn probeGridT(q: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    let Xw = P.uM * q;                              // → 世界，插值轴为世界轴
    return clamp((Xw - P.uWMin) * P.uWScale, vec3<f32>(0.), P.uPN - 1.001);
}
// flat probe 索引 → 平铺图集 texel。图集每行放 uProbeT 颗 probe（每颗 ncol 个 texel）；
// 老布局「x=系数，y=probe」在 P=11.9 万颗时高度直接超 GPU 上限（16384），采样静默全黑
// （2026-09-01 撞上：盘上 E 正常、实机角色漆黑，无任何报错）。valid 图同一套（ncol=1）。
fn probeTexel(flat_: i32, ncol: i32, k: i32, P: ClcProbe) -> vec2<i32> {
    let T = i32(P.uProbeT + .5);
    let r = flat_ / T;
    return vec2<i32>((flat_ - r * T) * ncol + k, r);
}
// 单颗 probe 的 E 重建（按 flat 索引）。probeE 的 8 角与最近邻视图共用这一份 ——
// v3 固化：probe 图集只存最终 E 的球谐（L1=4列 / L2=9列 / BIN=64方向），按法线重建即得该方向 E。
// nee / miss_mode / amb 已在导出时 compose 进 E，运行时不再读分账、不再组合（那些只 RT 用）。
// A7（摄像机侧折叠）的 probe 版。烘焙逃逸是黑：朝相机的射线立刻出画拿 0，
// E(朝相机) 被系统性饿死（实测雾津街头同一点 E(-z)=0.21 vs E(+z)=2.72，差 13x）——
// 而角色法线恰恰全朝相机、场景面全朝上 / 纵深 ⇒ 同一份 probe，场景亮角色黑。
// 假设与 RT 侧 A7 同一条：镜头背后的世界统计上镜像可见场景 ⇒ E(n) ≈ E(折叠 n)。
fn probeQueryN(nIn: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    var n = nIn;
    if (P.uFold > .5 && n.z < 0.) { n.z = -n.z; }
    return normalize(n);
}
fn probeEvalFlat(flat_: i32, nIn: vec3<f32>, P: ClcProbe,
                 uPL1: texture_2d<f32>, uPL2: texture_2d<f32>, uPBin: texture_2d<f32>) -> vec3<f32> {
    let n = probeQueryN(nIn, P);
    let mode = i32(P.uMode + .5);
    var E = vec3<f32>(0.);
    if (mode == 1) {
        // L1 = Geomerics/Enlighten 非线性重建（Hazel；制作人 2026-09-02 定为正式档）：
        // 逐通道 R0=c0·Y00（E 的 DC），R1=½·Y1·(c_x,c_y,c_z)，q=½(1+R̂1·n)，r=|R1|/R0，
        // p=1+2r，a=(1-r)/(1+r)，E=R0·(a+(1-a)(p+1)q^p)。永不为负，无截负翻色。
        // ⚠ 与 estimators.probe_eval_l1_geomerics 逐行同一公式，改一处必须改两处。
        let c0 = textureLoad(uPL1, probeTexel(flat_, 4, 0, P), 0).rgb;
        let c1 = textureLoad(uPL1, probeTexel(flat_, 4, 1, P), 0).rgb;   // y
        let c2 = textureLoad(uPL1, probeTexel(flat_, 4, 2, P), 0).rgb;   // z
        let c3 = textureLoad(uPL1, probeTexel(flat_, 4, 3, P), 0).rgb;   // x
        for (var ch = 0; ch < 3; ch++) {
            let R0 = max(c0[ch] * .282095, 1e-12);
            let R1 = .5 * .488603 * vec3<f32>(c3[ch], c1[ch], c2[ch]);
            let lenR1 = length(R1) + 1e-12;
            let q = clamp(.5 * (1. + dot(R1 / lenR1, n)), 0., 1.);
            let r = min(lenR1 / R0, .9999);
            let p = 1. + 2. * r;
            let a = (1. - r) / (1. + r);
            E[ch] = R0 * (a + (1. - a) * (p + 1.) * pow(q, p));
        }
        return E;
    } else if (mode == 2) {
        // l2 槽的列数 = uShK（L2=9 / L4=25），循环上限动态
        let K = i32(P.uShK + .5);
        for (var k = 0; k < 25; k++) { if (k >= K) { break; } E += textureLoad(uPL2, probeTexel(flat_, K, k, P), 0).rgb * shY(k, n); }
    } else {
        // 八面体分辨率由载荷 probes.bin_ob 决定（8=64 方向 / 16=256 方向）
        let ob = i32(P.uBinOb + .5);
        let B = ob * ob;
        let ouv = octaEnc(n) * f32(ob) - .5;
        let ob0 = vec2<i32>(floor(ouv));                 // 可为 -1/ob-1，越界交给 octaIdx
        let ofr = clamp(ouv - vec2<f32>(ob0), vec2<f32>(0.), vec2<f32>(1.));
        let b00 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(0, 0), ob), P);
        let b10 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(1, 0), ob), P);
        let b01 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(0, 1), ob), P);
        let b11 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(1, 1), ob), P);
        E = mix(mix(textureLoad(uPBin, b00, 0).rgb, textureLoad(uPBin, b10, 0).rgb, ofr.x),
                mix(textureLoad(uPBin, b01, 0).rgb, textureLoad(uPBin, b11, 0).rgb, ofr.x), ofr.y);
    }
    return max(E, vec3<f32>(0.));
}
// 查询点沿法线偏 0.525 × 最小格距（DDGI self-shadow bias 的 N 项，B=0.7）：
// 薄面两侧 probe 混投的漏光实测降 25~80%，亮度中位 / p95 同步小降。q↔世界 M 正交，
// 格距按 1/uWScale 现算即是 q 单位。⚠ 0.525 与 const.PROBE_QUERY_NORMAL_BIAS 同值。
fn probeE(q: vec3<f32>, n: vec3<f32>, P: ClcProbe,
          uPL1: texture_2d<f32>, uPL2: texture_2d<f32>, uPBin: texture_2d<f32>, uValid: texture_2d<f32>) -> vec3<f32> {
    let cellMin = min(min(1. / P.uWScale.x, 1. / P.uWScale.y), 1. / P.uWScale.z);
    let t = probeGridT(q + n * (0.525 * cellMin), P);
    let b0 = vec3<i32>(t);
    let f = t - vec3<f32>(b0);
    var wsum = 0.;
    var Esum = vec3<f32>(0.);
    let pn = vec3<i32>(P.uPN + .5);
    for (var c = 0; c < 8; c++) {
        let off = vec3<i32>(c & 1, (c >> 1u) & 1, (c >> 2u) & 1);
        let pi = min(b0 + off, pn - 1);
        var w = mix(1. - f.x, f.x, f32(off.x)) * mix(1. - f.y, f.y, f32(off.y)) * mix(1. - f.z, f.z, f32(off.z));
        let flat_ = pi.x * (pn.y * pn.z) + pi.y * pn.z + pi.z;
        w *= step(.002, textureLoad(uValid, probeTexel(flat_, 1, 0, P), 0).r);
        if (w < 1e-5) { continue; }
        Esum += probeEvalFlat(flat_, n, P, uPL1, uPL2, uPBin) * w;
        wsum += w;
    }
    if (wsum < 1e-4) { return ambIrr(n, P); }
    return Esum / wsum;
}
// 最近邻原始值（场景调试视图「无插值」档）：每个像素显示离它最近那颗 probe 的原始 E。
// 把数据画在**采样它的表面上**，固定视角也能逐颗检查（把点阵投到屏幕会自遮挡，没法看）；
// 与三线性档来回切 = 插值前后对照。网格映射 / SH 与 probeE 逐字同一套，唯一区别是 round。
// invalid 的格子**刻意亮品红**：这是查数据的视图，坏格必须扎眼，不许悄悄回落环境光。
fn probeENearest(q: vec3<f32>, n: vec3<f32>, P: ClcProbe,
                 uPL1: texture_2d<f32>, uPL2: texture_2d<f32>, uPBin: texture_2d<f32>, uValid: texture_2d<f32>) -> vec3<f32> {
    let t = probeGridT(q, P);
    let pn = vec3<i32>(P.uPN + .5);
    let pi = min(vec3<i32>(t + .5), pn - 1);
    let flat_ = pi.x * (pn.y * pn.z) + pi.y * pn.z + pi.z;
    if (textureLoad(uValid, probeTexel(flat_, 1, 0, P), 0).r < .002) { return vec3<f32>(1., 0., 1.); }
    return probeEvalFlat(flat_, n, P, uPL1, uPL2, uPBin);
}
//__PROBE_SAMPLING_END__

// ---- 体素卷：平铺 2D 图集上的手写三线性（≡ GL LINEAR + CLAMP_TO_EDGE 3D）----
// 体素卷是 3D 数据平铺成 Z 切片的 2D 图集（sampler3D 在这条管线里没有），手写三线性与 3D LINEAR 数学等价。
// ClcVol 字段：uVolN = 体素维度（float），uVolTiles = Z 切片平铺列数 / 行数，
// uQMin / uQMax = 体素盒的 q 范围（gatherRT 用）。
struct ClcVol {
    uVolN: vec3<f32>,
    uVolTiles: vec2<f32>,
    uQMin: vec3<f32>,
    uQMax: vec3<f32>,
}
fn volTap(t: texture_2d<f32>, xi: f32, yi: f32, zi: f32, V: ClcVol) -> vec4<f32> {
    let tx = zi - V.uVolTiles.x * floor(zi / V.uVolTiles.x);   // mod(zi, uVolTiles.x)，向下取整
    let ty = floor(zi / V.uVolTiles.x);
    return textureLoad(t, vec2<i32>(i32(tx * V.uVolN.x + xi), i32(ty * V.uVolN.y + yi)), 0);
}
fn sampleVol3(t: texture_2d<f32>, c01: vec3<f32>, V: ClcVol) -> vec4<f32> {
    let vp = c01 * V.uVolN - 0.5;
    let v0 = floor(vp);
    let f = clamp(vp - v0, vec3<f32>(0.0), vec3<f32>(1.0));
    let x0 = clamp(v0.x, 0.0, V.uVolN.x - 1.0);
    let x1 = clamp(v0.x + 1.0, 0.0, V.uVolN.x - 1.0);
    let y0 = clamp(v0.y, 0.0, V.uVolN.y - 1.0);
    let y1 = clamp(v0.y + 1.0, 0.0, V.uVolN.y - 1.0);
    let z0 = clamp(v0.z, 0.0, V.uVolN.z - 1.0);
    let z1 = clamp(v0.z + 1.0, 0.0, V.uVolN.z - 1.0);
    let c000 = volTap(t, x0, y0, z0, V); let c100 = volTap(t, x1, y0, z0, V);
    let c010 = volTap(t, x0, y1, z0, V); let c110 = volTap(t, x1, y1, z0, V);
    let c001 = volTap(t, x0, y0, z1, V); let c101 = volTap(t, x1, y0, z1, V);
    let c011 = volTap(t, x0, y1, z1, V); let c111 = volTap(t, x1, y1, z1, V);
    let a = mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y);
    let b = mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y);
    return mix(a, b, f.z);
}

// ================================ skyao probe：天穹遮蔽，乘在 GI 上 =========
// 载荷 lighting/<背景基名>/skyao_probe.bin：遮蔽矩，按 Z 切片横向平铺的
// rgba16f 图集，RGBA = (a0, a1x, a1y, a1z)。烘焙侧见 scene_fields.bake_skyao_probe。
//
// ⚠⚠ **坐标系不是 uM**。矩是用场景 depthConfig.M.R（**det=+1**）烘的，而 uM
//    是 lighting.json.world.M（**det=-1** 实验室查表那套）。混用一律不报错，
//    只是 a1·N 的方向整个镜像 —— 所以这里单独走 uSkyaoM（CLAUDE.md 铁律：两个 M 不许混）。
//
// ⚠ **必须除 cap0**，与场景侧 skyvis.png 的口径**相反**：
//    · 场景侧 sDay = (1-hemi) + hemi*skyvis 那边没有独立的朝向项，所以
//      skyvis.png 存的是不除 cap0 的 T(N)（开阔竖直墙 = 0.5）；
//    · 角色这边 probe 的球谐**已经带了方向性**，再乘一次朝向就是同一件事扣两遍。
//      所以要的是纯遮蔽系数 V ∈ [0,1]、**开阔处恒为 1（与朝向无关）**。
//__SKYAO_SAMPLING_BEGIN__
// skyao 图集 uSkyaoTex 由宿主声明、当形参传。ClcSkyao 字段：uSkyaoN = 网格维度；uSkyaoTiles = Z 切片平铺；
// uSkyaoMin / uSkyaoScale = 世界 AABB 下角与 1/尺寸（det=+1 世界系）；uSkyaoM = q → 世界（det=+1）；
// uSkyaoOn = 0 没有载荷、恒不遮蔽。uSkyaoBlend 只有宿主 main 读，不在这里。
struct ClcSkyao {
    uSkyaoN: vec3<f32>,
    uSkyaoTiles: vec2<f32>,
    uSkyaoMin: vec3<f32>,
    uSkyaoScale: vec3<f32>,
    uSkyaoM: mat3x3<f32>,
    uSkyaoOn: f32,
}
fn skyaoTap(xi: f32, yi: f32, zi: f32, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec4<f32> {
    let tx = zi - S.uSkyaoTiles.x * floor(zi / S.uSkyaoTiles.x);   // mod(zi, uSkyaoTiles.x)，向下取整
    let ty = floor(zi / S.uSkyaoTiles.x);
    return textureLoad(uSkyaoTex, vec2<i32>(i32(tx * S.uSkyaoN.x + xi),
                                            i32(ty * S.uSkyaoN.y + yi)), 0);
}
fn sampleSkyao(c01: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec4<f32> {
    // ⚠ 节点口径：烘焙格点是 linspace(x0,x1,n)（端点在盒边界，n-1 段），与 probeE / verify 同。
    //   这里曾抄了体素卷 sampleVol3 的格心口径（c01*N-0.5）—— 那是给格心体素用的，
    //   套在节点数据上 = 系统性偏移 (u-0.5) 格：盒中心为零、边缘半格（2026-09-01 制作人抓出）。
    let vp = c01 * (S.uSkyaoN - 1.0);
    let v0 = floor(vp);
    let f = clamp(vp - v0, vec3<f32>(0.0), vec3<f32>(1.0));
    let lo = clamp(v0, vec3<f32>(0.), S.uSkyaoN - 1.0);
    let hi = clamp(v0 + 1.0, vec3<f32>(0.), S.uSkyaoN - 1.0);
    // 平铺图集手写三线性：硬件过滤会跨 Z 切片串色（与体素卷同一个坑）
    let c000 = skyaoTap(lo.x, lo.y, lo.z, S, uSkyaoTex); let c100 = skyaoTap(hi.x, lo.y, lo.z, S, uSkyaoTex);
    let c010 = skyaoTap(lo.x, hi.y, lo.z, S, uSkyaoTex); let c110 = skyaoTap(hi.x, hi.y, lo.z, S, uSkyaoTex);
    let c001 = skyaoTap(lo.x, lo.y, hi.z, S, uSkyaoTex); let c101 = skyaoTap(hi.x, lo.y, hi.z, S, uSkyaoTex);
    let c011 = skyaoTap(lo.x, hi.y, hi.z, S, uSkyaoTex); let c111 = skyaoTap(hi.x, hi.y, hi.z, S, uSkyaoTex);
    let a = mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y);
    let b = mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y);
    return mix(a, b, f.z);
}
/** q 空间位置 + q 空间法线 → 天穹遮蔽 V ∈ [0,1]。无载荷时恒 1（不遮蔽）。 */
fn skyaoAt(q: vec3<f32>, n: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> f32 {
    if (S.uSkyaoOn < 0.5) { return 1.0; }
    let Xw = S.uSkyaoM * q;                                   // q → 世界（det=+1 那套）
    let c01 = clamp((Xw - S.uSkyaoMin) * S.uSkyaoScale, vec3<f32>(0.0), vec3<f32>(1.0));
    let m = sampleSkyao(c01, S, uSkyaoTex);
    let nw = normalize(S.uSkyaoM * n);
    let cap = max((1.0 + nw.y) * 0.5, 1.0f / 255.0f);          // 无遮挡时的解析上限
    return clamp((m.x + dot(m.yzw, nw)) / cap, 0.0, 1.0);
}
//__SKYAO_SAMPLING_END__
/** 临时诊断（uShowN==3）：把查表落点画成盒内归一化坐标 RGB。 */
fn skyaoBox(q: vec3<f32>, S: ClcSkyao) -> vec3<f32> {
    if (S.uSkyaoOn < 0.5) { return vec3<f32>(1.0, 0.0, 1.0); }           // 品红 = 根本没载荷
    return clamp((S.uSkyaoM * q - S.uSkyaoMin) * S.uSkyaoScale, vec3<f32>(0.0), vec3<f32>(1.0));
}
/** 临时诊断（uShowN==5）：把 V 编成**色带** —— 色相扛得住后处理 / 色调映射，灰度扛不住。
    红<0.15 橙<0.35 黄<0.55 绿<0.75 蓝>=0.75 */
fn skyaoBand(q: vec3<f32>, n: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec3<f32> {
    if (S.uSkyaoOn < 0.5) { return vec3<f32>(1.0, 0.0, 1.0); }
    let v = skyaoAt(q, n, S, uSkyaoTex);
    if (v < 0.15) { return vec3<f32>(1.0, 0.0, 0.0); }
    if (v < 0.35) { return vec3<f32>(1.0, 0.45, 0.0); }
    if (v < 0.55) { return vec3<f32>(1.0, 1.0, 0.0); }
    if (v < 0.75) { return vec3<f32>(0.0, 1.0, 0.0); }
    return vec3<f32>(0.0, 0.55, 1.0);
}
/** 临时诊断（uShowN==4）：把采样到的原始矩 a0 画成灰度。 */
fn skyaoRaw(q: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec3<f32> {
    if (S.uSkyaoOn < 0.5) { return vec3<f32>(1.0, 0.0, 1.0); }
    let m = sampleSkyao(clamp((S.uSkyaoM * q - S.uSkyaoMin) * S.uSkyaoScale, vec3<f32>(0.0), vec3<f32>(1.0)), S, uSkyaoTex);
    return vec3<f32>(m.x);
}

fn ambRad(d: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    let m = vec3<f32>(d.xy, abs(d.z));
    var L = vec3<f32>(0.);
    for (var k = 0; k < 9; k++) { L += P.uAmbSH[k] * shY(k, m); }
    return max(L, vec3<f32>(0.)) * P.uAmbStrength;
}
fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 射线-体素盒求交：把起点推进到盒入口（与实验室 pipeline._ray_box_enter 同式）。
// 伪世界只覆盖背景画那一块 q 盒，角色带常常高过画面上沿；起点在盒外就一步出界的写法会让
// 上半身全 miss。返回 x = 进盒距离，y < 0 = 这条射线进不去。cache 侧同一个坑在烘焙里已修。
fn boxEnter(p0: vec3<f32>, dn: vec3<f32>, hi: vec3<f32>) -> vec2<f32> {
    let d = select(dn, vec3<f32>(1e-6), abs(dn) < vec3<f32>(1e-6));
    let t0 = (vec3<f32>(0.) - p0) / d;
    let t1 = (hi - p0) / d;
    let lo3 = min(t0, t1);
    let hi3 = max(t0, t1);
    let tn = max(0., max(max(lo3.x, lo3.y), lo3.z));
    return vec2<f32>(tn, min(min(hi3.x, hi3.y), hi3.z) - tn);
}

// ClcRt 字段：uSpp / uMSteps = 每像素射线数 / 每射线步数；uMissMode（0 = miss 记
// J̄×强度，1 = 不计入再归一）；uNEE（1 = 灯走下面的确定性直射）；uStep = 步长（体素单位）；
// uLightCount / uLightQ / uLightE = 烘焙期反解的光源 surfel（q 位置 + 面积 / 发光辐射）。
struct ClcRt {
    uSpp: f32,
    uMSteps: f32,
    uMissMode: f32,
    uNEE: f32,
    uStep: f32,
    uLightCount: f32,
    uLightQ: array<vec4<f32>, 48>,
    uLightE: array<vec4<f32>, 48>,
}
// RT gather（uMode == 0 的诊断档）。fragCoord = 入口的位置内建量 .xy（逐像素随机旋转的种子）。
fn gatherRT(q0: vec3<f32>, n: vec3<f32>, fragCoord: vec2<f32>, P: ClcProbe, V: ClcVol, R: ptr<function, ClcRt>,
            uVolRad: texture_2d<f32>, uVolEmit: texture_2d<f32>) -> vec3<f32> {
    let spp = i32((*R).uSpp + .5);
    let msteps = i32((*R).uMSteps + .5);
    let lightCount = i32((*R).uLightCount + .5);
    var tRaw: vec3<f32>;
    if (abs(n.z) < .95) { tRaw = cross(n, vec3<f32>(0., 0., 1.)); } else { tRaw = cross(n, vec3<f32>(1., 0., 0.)); }
    let t = normalize(tRaw);
    let b = cross(n, t);
    let scaleIdx = vec3<f32>(V.uVolN - 1.) / max(V.uQMax - V.uQMin, vec3<f32>(1e-5));
    let invN = 1. / V.uVolN;
    let p0 = (q0 - V.uQMin) * scaleIdx;
    let rot = hash12(fragCoord) * 6.2831853;
    let GA = 2.399963;
    var acc = vec3<f32>(0.);
    var nHit = 0.;
    for (var i = 0; i < 192; i++) {
        if (i >= spp) { break; }
        let u1 = (f32(i) + .5) / f32(spp);
        let ph = f32(i) * GA + rot;
        let r = sqrt(u1);
        let ld = vec3<f32>(r * cos(ph), r * sin(ph), sqrt(max(0., 1. - u1)));
        var dir = normalize(t * ld.x + b * ld.y + n * ld.z);
        if (P.uFold > .5 && dir.z < 0.) { dir.z = -dir.z; }      // A7：摄像机侧折叠进观测半空间
        let dn = normalize(dir * scaleIdx);
        let dIdx = dn * (*R).uStep;
        let be = boxEnter(p0, dn, V.uVolN - 1.);
        var hit = false;
        var Li = vec3<f32>(0.);
        if (be.y < 0.) {                                           // 进不去体素盒 → 当 miss 记账
            if ((*R).uMissMode < .5) { acc += ambRad(dir, P); }
            continue;
        }
        var p = p0 + dn * be.x + dIdx * 1.5;                       // 先推进到入口，再留 1.5 步自碰撞余量
        for (var s = 0; s < 256; s++) {
            if (s >= msteps) { break; }
            p += dIdx;
            if (any(p < vec3<f32>(0.)) || any(p > V.uVolN - 1.)) { break; }
            let v = sampleVol3(uVolRad, (p + .5) * invN, V);
            if (v.a > .45) {
                Li = v.rgb;                                        // base only（画作）
                if ((*R).uNEE < .5) { Li += sampleVol3(uVolEmit, (p + .5) * invN, V).rgb; }   // NEE 关：emit 走射线
                hit = true;
                break;
            }
        }
        if (hit) { acc += Li; nHit += 1.; }
        else if ((*R).uMissMode < .5) { acc += ambRad(dir, P); }   // J̄ × 强度（0 = miss 记黑）；uMissMode == 1：miss 不计入，下面 renormalize
    }
    var E: vec3<f32>;
    if ((*R).uMissMode > .5) { E = acc * (3.14159265 / max(nHit, 1.)); } else { E = acc * (3.14159265 / f32(spp)); }
    if ((*R).uNEE > .5) {
        // 精确确定性直射：遍历全部光源 surfel + 阴影 march（各向同性，无发射端余弦）
        for (var i = 0; i < 48; i++) {
            if (i >= lightCount) { break; }
            let lq = (*R).uLightQ[i].xyz;
            let dl = lq - q0;
            let r2 = max(dot(dl, dl), 0.04);
            let r = sqrt(r2);
            let d = dl / r;
            let cr = max(dot(n, d), 0.);
            if (cr <= 0.) { continue; }
            let pi0 = (q0 - V.uQMin) * scaleIdx;
            let pi1 = (lq - V.uQMin) * scaleIdx;
            let dli = pi1 - pi0;
            let li_ = length(dli);
            let sd = dli / max(li_, 1e-5) * 1.6;
            let nst = max((li_ - 1.8) / 1.6, 0.);
            var p = pi0 + sd * 1.2;
            var vis = 1.;
            for (var s = 0; s < 160; s++) {
                if (f32(s) >= nst) { break; }
                p += sd;
                if (any(p < vec3<f32>(0.)) || any(p > V.uVolN - 1.)) { break; }
                if (sampleVol3(uVolRad, (p + .5) * (1. / V.uVolN), V).a > .45) { vis = 0.; break; }
            }
            E += (*R).uLightE[i].rgb * (vis * cr * (*R).uLightQ[i].w / r2);
        }
    }
    return E;
}

//__CLC_END__
`,Ou=new Map;function ku(e){return[e.addressModeU,e.addressModeV,e.addressModeW,e.magFilter,e.minFilter,e.mipmapFilter,e.lodMinClamp,e.lodMaxClamp,e.compare??``,e.maxAnisotropy].join(`|`)}function Au(e){let t=e.style,n=ku(t),r=Ou.get(n);return r||(r=new ie({addressModeU:t.addressModeU,addressModeV:t.addressModeV,addressModeW:t.addressModeW,magFilter:t.magFilter,minFilter:t.minFilter,mipmapFilter:t.mipmapFilter,lodMinClamp:t.lodMinClamp,lodMaxClamp:t.lodMaxClamp,compare:t.compare,maxAnisotropy:t.maxAnisotropy}),r.destroy=()=>{},Ou.set(n,r)),r}var ju=`
fn fgSample(uv: vec2<f32>, hasCoverage: f32, outDepth: ptr<function, f32>) -> f32 {
    *outDepth = 0.0;
    if (hasCoverage < 0.5) { return 0.0; }
    let s = textureSampleLevel(uFgCoverage, uFgCoverageSampler, uv, 0.0);
    if (s.r <= 0.5) { return 0.0; }
    if (s.b > 0.5) {
        *outDepth = s.g / max(s.r, 1e-4);
        return 1.0;
    }
    return 2.0;
}
`;function Mu(e,t){return`@group(${e}) @binding(${t}) var uFgCoverage: texture_2d<f32>;\n@group(${e}) @binding(${t+1}) var uFgCoverageSampler: sampler;\n`}function Nu(e,t){let n=`//__${t}_BEGIN__`,r=`//__${t}_END__`,i=e.indexOf(n),a=e.indexOf(r);if(i<0||a<0)throw Error(`[CharacterShadingFilter] charLightCommon.wgsl 缺切片标记 ${t}`);return e.substring(i+n.length,a)}var Pu=(()=>{let e=Nu(Du,`CLC`),t=`//__CHAR_SHADE_CORE_WGSL__`;if(!e.includes(t))throw Error(`[CharacterShadingFilter] charLightCommon.wgsl 缺着色核心注入点`);return e.replace(t,()=>Eu)})();(()=>{let e=Pu.indexOf(`//__SKYAO_SAMPLING_BEGIN__`),t=Pu.indexOf(`//__SKYAO_SAMPLING_END__`);if(e<0||t<0)throw Error(`[CharacterShadingFilter] 缺 SKYAO_SAMPLING 切片标记(WGSL)`);return Pu.slice(e,t+24)})(),Nu(Pu,`PROBE_SAMPLING`),`${Mu(1,3)}${Pu}${ju}`;function Fu(e){let t=Math.min(Math.max(e,1e3),4e4)/100,n,r,i;t<=66?(n=255,r=99.4708025861*Math.log(t)-161.1195681661,i=t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307):(n=329.698727446*(t-60)**-.1332047592,r=288.1221695283*(t-60)**-.0755148492,i=255);let a=e=>Math.min(Math.max(e/255,0),1);return[a(n)**2.2,a(r)**2.2,a(i)**2.2]}Fu(6500);var Iu=`// ============================================================================
// 统一光影系统 · 光照核心（单一真相源）
//
// 本文件是 S(L, 几何) 的**唯一**实现，被多方共用：场景光照 pass（逐像素，写进缓存 RT）、
// 背景合成、角色着色（filter 与 mesh 两条路径）、粒子受光。一份 WGSL 字符串拼进各 shader，
// 消灭镜像漂移——改这里 = 各处同时改，这正是要的。与 master（GLSL 版 lightingCore.glsl）
// 逐像素一致由 tools/render_parity 的「光照片段 /」「场景光照 /」用例钉住，改了必须重跑对照。
//
// ⚠ 铁律 0（制作人 2026-08-30）：**一切光照在世界空间算**（M-world、单位 wu）。本段函数只吃世界量，
//   不做任何空间换算；q 空间的量必须先转到世界空间再喂进来（坐标卡）。唯一例外是阴影 march：
//   沿深度场行进本来就在伪世界 q 空间（坐标卡列的三类豁免之一）。
//
// ⚠ 色温→RGB 在 CPU 侧算好后以 uniform 传入（避免 shader 里的 log/pow）。
//
// 约定：
//   - 一切颜色量在**线性**空间；显示变换是流水线最后一步，且同时作用于场景与角色。
//   - 距离量一律 **wu**，进出都不换算（本项目只有这一个空间单位）
//     （世界单位是逐场景的，实测 1 wu 在不同场景是 2.0–10.0 m）。
//   - 点光/聚光的 intensity 进来时必须已是 **wu 强度**（作者面相对 q 定义，
//     打包处折 I_q × wuPerQUnit²，见 lightPacking.pointIntensityWu）：1/r² 的 r 是 wu，
//     强度的尺必须跟它走。面光的 intensity 是辐亮度、平行光的是照度，与长度单位无关，原样。
//
// 【怎么拼】vite ?raw 引入，切片（wgslChunks.ts 已切好 LC_WGSL / WR_CORE_WGSL）：
//
//     const src = 宿主的 struct / 绑定声明 + WR_CORE_WGSL + LC_WGSL + 入口函数;
//
//   · 本段**一个 uniform / 绑定都不读**：全部输入走形参，宿主怎么分组、怎么起名都行，
//     本文件不要求宿主声明任何东西。
//   · lcMarchVisibility 调 WR_CORE 的 wrQToPixel / wrDecodeSceneDepth，所以 WR_CORE 必须
//     一起拼进同一个模块（WGSL 模块级声明与顺序无关，前后都行）。
//   · WGSL 没有预处理器、没有 include guard：**同一模块只许拼一次**，拼两次是重复定义、编译失败。
//
// 【写法约束（与 master 的 GLSL 版数值不变）】
//   · lcMarchVisibility 的深度图多一个 sampler 形参（纹理与采样器分开），
//     采样用 textureSampleLevel(…, 0.0)：它能在循环 / 分支里调，对单级纹理等价于隐式 LOD
//     （本项目运行时纹理都是单级）。
//   · 形参不可写：改写形参的地方（lcLinearToSrgb 的 x）用局部量，式子不变。
//   · 三元式一律写成 if/else（不用 select：select 两边都求值）。
//   · 字面量与字面量的算术（1.0 / 2.4 这类）写成 f32 后缀，让常量折叠在 32 位里做，避免 1 ulp 的折叠差。
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件（以及任何会被拼进着色器的
//   WGSL 片段）的注释里不许出现「at 号 + group / binding + 括号」字样，struct 体内不许写注释。
// ============================================================================

//__LIGHTING_CORE_BEGIN__

const LC_PI: f32 = 3.14159265358979323846;
const LC_LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

// ---------------------------------------------------------------- 光源类型
// 与 LightDef.kind 对应：0=point 1=spot 2=area 3=directional 4=line
const LC_POINT: i32 = 0;
const LC_SPOT: i32 = 1;
const LC_AREA: i32 = 2;
const LC_DIRECTIONAL: i32 = 3;
const LC_LINE: i32 = 4;

// ---------------------------------------------------------------- 衰减
// 物理 1/r² + 有限作用半径的高斯截断。
// 截断是必须的：没有它，夜景里一盏灯会把整张图都染暖（实测过）。
fn lcFalloff(r2: f32, range: f32, softening: f32) -> f32 {
    let cut = exp(-r2 / max(range * range, 1e-6));
    return cut / (r2 + softening);
}

// ---------------------------------------------------------------- 点光
fn lcPointLight(P: vec3<f32>, N: vec3<f32>, lightPos: vec3<f32>, color: vec3<f32>,
                intensity: f32, range: f32, softening: f32, vis: f32) -> vec3<f32> {
    let v = lightPos - P;
    let r2 = dot(v, v);
    let ndl = max(dot(N, v * inverseSqrt(max(r2, 1e-12))), 0.0);
    return color * (intensity * ndl * lcFalloff(r2, range, softening) * vis);
}

// ---------------------------------------------------------------- 聚光
// spotDir 指向光**射出**的方向；cosInner/cosOuter 为锥体余弦（inner > outer）。
fn lcSpotLight(P: vec3<f32>, N: vec3<f32>, lightPos: vec3<f32>, spotDir: vec3<f32>, color: vec3<f32>,
               intensity: f32, range: f32, softening: f32,
               cosInner: f32, cosOuter: f32, vis: f32) -> vec3<f32> {
    let v = lightPos - P;
    let r2 = dot(v, v);
    let L = v * inverseSqrt(max(r2, 1e-12));
    // 锥角过渡按规范定义的式子展开写:WGSL 内建 smoothstep 与 master 的 GLSL 内建差几个 ulp(SwiftShader 实测),
    // 锥边附近会被放大成可见的半精度差;展开式两边逐位一致(对照「场景光照 /」「光照片段 /」)
    let coneT = clamp((dot(-L, normalize(spotDir)) - cosOuter) / (cosInner - cosOuter), 0.0, 1.0);
    let cone = coneT * coneT * (3.0 - 2.0 * coneT);
    if (cone <= 0.0) { return vec3<f32>(0.0); }
    let ndl = max(dot(N, L), 0.0);
    return color * (intensity * ndl * cone * lcFalloff(r2, range, softening) * vis);
}

// ---------------------------------------------------------------- 面光（矩形）
// **Lambert 的闭式解，零采样**（Lambert 1760 的多边形辐照度公式）：
//
//     E = (1/2π) Σ_边 acos(p_i·p_j) · ( normalize(p_i × p_j) · N )
//
// p_i 是矩形四顶点投影到着色点单位球上的方向。四条边 = 四次 acos。
// 本项目 Lambert-only（不重建 specular，见理论推导 §16.3），所以**不需要 LTC**
// ——LTC 是为 GGX 高光准备的，我们不做高光，直接吃最便宜的这条。
//
// ⚠ 未做 horizon clip：多边形跨越着色点地平线时本式偏大，靠外层 max(0) 兜底。
//   实测发现问题再补真裁剪（裁到 N·p>0 半空间，最多变 5 边）。
//
// 返回**带符号**值：正 = 着色点在多边形正面（按顶点绕向定的正面）。
// 钳位交给 lcAreaLight —— 双面光要的是 abs 而不是 max(0)。四条边手写展开（不用 4 元素数组）。
fn lcRectIrradiance(P: vec3<f32>, N: vec3<f32>, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32>, v3: vec3<f32>) -> f32 {
    let p0 = normalize(v0 - P);
    let p1 = normalize(v1 - P);
    let p2 = normalize(v2 - P);
    let p3 = normalize(v3 - P);

    var sum = 0.0;
    var ax: vec3<f32>;
    var ln: f32;

    ax = cross(p0, p1); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p0, p1), -1.0, 1.0)) * dot(ax / ln, N); }
    ax = cross(p1, p2); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p1, p2), -1.0, 1.0)) * dot(ax / ln, N); }
    ax = cross(p2, p3); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p2, p3), -1.0, 1.0)) * dot(ax / ln, N); }
    ax = cross(p3, p0); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p3, p0), -1.0, 1.0)) * dot(ax / ln, N); }

    return sum * (0.5 / LC_PI);
}

// 面光的四个角由中心 + 两条半轴给出（半轴已是世界单位向量）。
fn lcAreaLight(P: vec3<f32>, N: vec3<f32>, center: vec3<f32>, halfU: vec3<f32>, halfV: vec3<f32>,
               color: vec3<f32>, intensity: f32, range: f32, twoSided: bool, vis: f32) -> vec3<f32> {
    let d = center - P;
    let r2 = dot(d, d);
    // 作用半径截断：面光同样需要，否则远处也被它抬亮
    let cut = exp(-r2 / max(range * range, 1e-6));
    if (cut < 1e-4) { return vec3<f32>(0.0); }
    // 单面光：着色点在背面则无贡献
    if (!twoSided) {
        let n = normalize(cross(halfU, halfV));
        if (dot(n, -d) <= 0.0) { return vec3<f32>(0.0); }
    }
    // ⚠ 顶点必须按「从正面看是逆时针」绕，否则 Lambert 多边形式给出的符号是反的。
    //   原来写的是 (c−U−V, c+U−V, c+U+V, c−U+V) —— 那个绕向与
    //   cross(halfU, halfV) 定的正面**反着**，于是在**正面**算出负值、被 max(0)
    //   吃成 0，在**背面**反而算出正值。净效果：**面光照亮的是错误的一侧**。
    //
    //   实测（面板在 (950,357,0)、半轴 150×100、地面法线 (0,1,0)）：
    //     面板朝下、地在正下方（该亮）→ 单面判据通过，但 E = −0.1328 ⇒ 0
    //     面板朝上、地在正下方（该黑）→ 单面判据拒绝，E 却 = +0.1328
    //   两者恰好互换。翻转绕向后四种情形（该亮 / 该黑 × 朝下 / 朝前）全部正确。
    var E = lcRectIrradiance(P, N,
                             center - halfU - halfV,
                             center - halfU + halfV,
                             center + halfU + halfV,
                             center + halfU - halfV);
    // 双面光两侧都发光 ⇒ 取绝对值；单面光已被上面的判据挡过，负值只可能是
    // 未做 horizon clip 的数值残差，钳掉。
    if (twoSided) { E = abs(E); } else { E = max(E, 0.0); }
    return color * (intensity * E * cut * vis);
}

// ---------------------------------------------------------------- 线光（落雷那一道雷身，只给运行时灯用）
// 从 a 到 a + seg 的一整条均匀发光线，总强度 intensity（= 同一强度的点光均匀摊在整条线上，
// 离得远时与点光一样；打包处与点光同样 × wuPerQUnit²）。
//
// Lambert（N·L）× 1/(r² + 软化) 沿线的**闭式积分**，零采样（逐点采样在贴近雷身的墙上会是一串亮斑）：
//
//     E = λ ∫ (α + β s) / (s² + b²)^{3/2} ds            λ = intensity / len
//       = λ [ α/b² · s/√(s²+b²) − β/√(s²+b²) ]  从 s0 到 s1
//
// s = 沿线坐标（原点取着色点在这条直线上的垂足），b² = 垂距² + 软化，α = N·(着色点→垂足)，β = N·线方向。
// 作用半径的截断取线上离着色点最近那一点（线远长于截断半径时才有误差）。
// ⚠ 未做 horizon clip：线有一截在着色点地平线以下时那一截贡献负值，本式偏小；外层 max(0) 兜底。
fn lcLineLight(P: vec3<f32>, N: vec3<f32>, a: vec3<f32>, seg: vec3<f32>, color: vec3<f32>,
               intensity: f32, range: f32, softening: f32, vis: f32) -> vec3<f32> {
    let len = length(seg);
    if (len < 1e-3) { return lcPointLight(P, N, a, color, intensity, range, softening, vis); }
    let u = seg / len;
    let w = a - P;
    let s0 = dot(w, u);
    let perp = w - s0 * u;
    let b2 = dot(perp, perp) + softening;
    let s1 = s0 + len;
    let r0 = inverseSqrt(s0 * s0 + b2);
    let r1 = inverseSqrt(s1 * s1 + b2);
    let I = (dot(N, perp) / b2) * (s1 * r1 - s0 * r0) - dot(N, u) * (r1 - r0);
    let nearest = w + clamp(-s0, 0.0, len) * u;
    let cut = exp(-dot(nearest, nearest) / max(range * range, 1e-6));
    return color * (intensity / len * max(I, 0.0) * cut * vis);
}

// ---------------------------------------------------------------- 平行光（日/月）
fn lcDirectionalLight(N: vec3<f32>, toLight: vec3<f32>, color: vec3<f32>, intensity: f32, vis: f32) -> vec3<f32> {
    return color * (intensity * max(dot(N, normalize(toLight)), 0.0) * vis);
}

// ---------------------------------------------------------------- 天光
// 天光 = 天光色 × 强度 × ( (1−hemi) + hemi × 天穹可见性 )。
// 可见性来自**烘出来的几何场**（逐像素 skyvis.png / 角色用 3D 网格），与光无关，
// 光怎么变都不用重烘。（运行时加光项已删，本函数现役无消费者，照搬留档。）
//
// · hemi = 有多少比例的天光是"从上方来、会被遮住"的；1−hemi 是各向同性的底。
//   hemi 越大，巷道 / 檐下与开阔地的反差越强。
// · aoStrength 是可读性旋钮：1 = 完全吃遮蔽，0 = 完全不吃（mix 把可见性拉回 1）。
//
// ⚠ **本函数已含半球项，调用方不要再乘一遍**。踩过：调用处又乘了
//   (1−hemi)+hemi·skyvis，等于把可见性算了两次，整场景暗到离线口径的 0.6 倍
//   （sky 均值 0.48，比值正好对上）。与 relight.py 的 s_new 逐项对齐即可。
fn lcSkyLight(color: vec3<f32>, intensity: f32, skyvis: f32, hemi: f32, aoStrength: f32) -> vec3<f32> {
    let v = mix(1.0, clamp(skyvis, 0.0, 1.0), clamp(aoStrength, 0.0, 1.0));
    return color * (intensity * ((1.0 - hemi) + hemi * v));
}

// ---------------------------------------------------------------- 阴影 march
// 沿光线在**伪世界 q 空间**里 march 深度场：落到可见壳背后、且在 thick 厚度窗内 = 被挡
// （march 是 q 空间的三类豁免之一，见坐标卡）。
// ⚠ 这是**伪世界空间**的行进，不是屏幕空间的模糊 / 衰减——
//   每一步都把 q 反投影回像素去取该处的真实表面深度，深度分离是逐步做的。
//   （2026-07-21 决策的被否项「在屏幕空间直接模糊或积分」指的是不做深度分离的那种，
//     与本函数不是一回事。）
//
// 依赖 WR_CORE 的 wrQToPixel / wrDecodeSceneDepth，要一起拼进同一模块。
// thick 是厚度窗：太薄会漏挡，太厚会让远处的墙挡住近处（"隔山打影"）。
//
// 返回 [0,1]：1 = 未被挡。定步长、无抖动 ⇒ 同参数必出同结果。
fn lcMarchVisibility(depthTex: texture_2d<f32>, depthSmp: sampler, depthTexSize: vec2<f32>,
                     ppu: f32, cx: f32, cy: f32,
                     invert: f32, dScale: f32, dOffset: f32,
                     q0: vec3<f32>, dirQ: vec3<f32>, steps: i32, marchLen: f32,
                     bias0: f32, thick: f32) -> f32 {
    let st = marchLen / f32(max(steps, 1));
    for (var i = 1; i <= 128; i++) {
        if (i > steps) { break; }                  // 常量上界 + 提前 break（与 master 的 GLSL 版同一个循环形状）
        let q = q0 + dirQ * (st * f32(i));
        let px = wrQToPixel(q, ppu, cx, cy);
        let uv = px / depthTexSize;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { continue; }
        let ds = wrDecodeSceneDepth(textureSampleLevel(depthTex, depthSmp, uv, 0.0), invert, dScale, dOffset);
        let pen = q.z - ds;
        let bias = bias0 + 0.02 * st * f32(i);
        if (pen > bias && pen < thick) { return 0.0; }
    }
    return 1.0;
}

// ---------------------------------------------------------------- 高度雾
// 正交相机 ⇒ **每像素视线方向恒定** ⇒ 指数高度雾的积分有闭式解，无需 march。
//
//     σ(y) = σ₀ · exp( −(y − baseY) / H )
//     ∫σ ds = σ₀ · dist · (a − b) · H / (ySurf − yCam)，  a=exp(−(yCam−baseY)/H)
//                                                        b=exp(−(ySurf−baseY)/H)
//
// dist 为沿视线的行程（世界单位）。ySurf≈yCam 时退化为常数介质。
//
// ⚠ 参数按**消光系数 σ** 定义，不按"最终混合系数"——将来上体积雾时，
//   已调好的浓度 / 高度 / 颜色全部继续有效（需求 R3 的可扩展性要求）。
fn lcOpticalDepth(dist: f32, yCam: f32, ySurf: f32,
                  sigma0: f32, scaleH: f32, baseY: f32) -> f32 {
    let H = max(scaleH, 1e-4);
    let a = exp(-(yCam - baseY) / H);
    let b = exp(-(ySurf - baseY) / H);
    let dy = ySurf - yCam;
    if (abs(dy) < 1e-5) { return sigma0 * a * dist; }
    return sigma0 * dist * (a - b) * H / dy;
}

// 应用雾：透射 T 混合场景色与散射色。场景与角色吃同一组参数、各用自己的深度。
fn lcApplyFog(lin: vec3<f32>, opticalDepth: f32, scatterColor: vec3<f32>) -> vec3<f32> {
    let T = exp(-max(opticalDepth, 0.0));
    return lin * T + scatterColor * (1.0 - T);
}

// ---------------------------------------------------------------- 显示变换
// 顺序固定：曝光 → tonemap → 白平衡 → 饱和 → 对比 → 暗部提升 → sRGB
//
// ⚠ **显示变换绝不能烤进辐射场**。当前离线工具把 ev 与 clamp 烤进 PNG，
//   导致导出图动态范围只有 17×，角色 gather 到的光等于没有（2026-08-20 实测）。
// ⚠ tonemap='none'（mode=0）时本函数与 tools/scene_relight/relight.py 的调色段
//   **逐步等价**，已调好的预设参数可直接复用。改这里要同步跑 parity 测试。
fn lcTonemap(x: vec3<f32>, mode: i32) -> vec3<f32> {
    if (mode == 1) {                     // reinhard
        return x / (1.0 + x);
    } else if (mode == 2) {              // filmic（ACES 近似，Narkowicz）
        let v = x * 0.6;
        return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    return x;                            // none
}

fn lcLinearToSrgb(xIn: vec3<f32>) -> vec3<f32> {
    let x = clamp(xIn, vec3<f32>(0.0), vec3<f32>(1.0));
    return mix(x * 12.92, 1.055 * pow(x, vec3<f32>(1.0f / 2.4f)) - 0.055,
               step(vec3<f32>(0.0031308), x));
}

fn lcSrgbToLinear(x: vec3<f32>) -> vec3<f32> {
    return mix(x / 12.92, pow((x + 0.055) / 1.055, vec3<f32>(2.4)),
               step(vec3<f32>(0.04045), x));
}

fn lcDisplayTransform(lin: vec3<f32>, ev: f32, tonemapMode: i32, whiteBalance: vec3<f32>,
                      saturation: f32, contrast: f32,
                      lift: f32, liftColor: vec3<f32>) -> vec3<f32> {
    var c = lin * exp2(ev);
    c = lcTonemap(c, tonemapMode);
    c *= whiteBalance;
    if (saturation != 1.0) {
        let l = dot(c, LC_LUMA);
        c = vec3<f32>(l) + (c - vec3<f32>(l)) * saturation;
    }
    if (contrast != 1.0) {
        c = 0.18 * pow(max(c, vec3<f32>(0.0)) / 0.18, vec3<f32>(contrast));
    }
    if (lift > 0.0) {
        let l = dot(c, LC_LUMA);
        c += liftColor * (lift * 0.08 * exp(-l / 0.06));
    }
    return lcLinearToSrgb(c);
}

// ---------------------------------------------------------------- 场景重打光（已停用路径的遗留函数，照搬）
// 场景的 albedo 被画进了像素里，拿不出来，所以走「先除掉白天光、再乘上新光」。
// 角色的 albedo 是显式的，直接乘 S —— **两边算的是同一个 S**，这是"完美融合"的根。
// （2026-08-30 起光影改成「原画 + 加性实体灯」，运行时不再重打光，本函数无消费者。）
//
// ⚠ 干活的是 S_day / S_new 里的天穹可见性与定向光投影；除 / 乘只是最后一步算术。
//   **被否**（2026-08-20 制作人当场否决）：S 只用法线朝上项、不做任何 march 的写法
//   ——那是逐像素调色，画不出巷道与屋檐下的遮蔽结构，看着就是贴滤镜。勿回退。
fn lcRelightScene(paintingLinear: vec3<f32>, sDay: vec3<f32>, sNew: vec3<f32>, ratioMax: f32) -> vec3<f32> {
    let ratio = clamp(sNew / max(sDay, vec3<f32>(1e-4)), vec3<f32>(0.0), vec3<f32>(ratioMax));
    return paintingLinear * ratio;
}

//__LIGHTING_CORE_END__
`,Lu=`// ============================================================================
// worldReconstruct.wgsl —— 「世界重建数学」唯一真相源 (single source of truth)
//
// 收编范围：屏幕/几何 → 场景世界 → 像素栅格 → 伪世界 q → M-world → 碰撞格，
// 以及深度图/行走面场的 RG16 解码与「直立 quad」精灵深度代理。
// 收编前这套数学在 9 处各写一份（3 个角色滤镜 + mesh 着色 + 2 个影子 + 调试滤镜
// + 2 个 CPU 版），口径已经漂出 20 条差异。**任何一处再内联重写都算回归。**
// 与 master（GLSL 版 worldReconstruct.glsl，本文件由它逐函数移植而来）逐像素一致由
// tools/render_parity 的「光照片段 / WR」用例钉住。下文「站点」「原文」指收编时各处的 GLSL 原文位置（历史出处）。
//
// ---------------------------------------------------------------------------
// 【设计铁律 1】本文件里的函数**一个 uniform / 绑定都不读**。
//   全部输入走形参（纹理、采样器与全部标量都是形参）。理由不是洁癖：9 处站点的 uniform
//   名/类型/单位互不相同（uSceneSize 在遮挡路是世界单位、在 BackgroundDebugFilter 是屏幕像素；
//    R 在影子里是 6 个标量、在调试滤镜里是另外 6 个同义标量、在 CPU 里是 9 个字段；
//    uM 更是**另一个矩阵**），读 uniform 就等于把这些分叉焊死。
//   纯函数 = 可以逐行替换而字节级不变，控制流（早退/门闸/discard）留在站点。
//
// 【设计铁律 2】表达式按站点原文逐字照抄，**不化简、不用 dot()、不用 mat3*vec3**。
//   a.x*b.x + a.y*b.y + a.z*b.z 与 dot(a,b) 不保证同一棵表达式树
//   （后者允许 FMA/重结合）。验收是「表现零变化」，所以宁可啰嗦。
//
// 【设计铁律 3】两个「M」永远不许混。
//   · depthConfig.M.R  —— **det = +1**（游戏约定）。q → M-world。
//     用途：碰撞格反投影、planar 影子、F2 碰撞可视化、CPU isCollision。
//     本文件用 wrQToWorld*(r0, r1, r2, …) 一族。
//   · lighting.json world.M —— **det = −1**（实验室 GL 右手，Z 轴反号）。q → probe 晶格世界。
//     用途：**只有** probe/体素查表（Xw = uM * q）。
//     本文件用 wrQToProbeWorld(mat3x3, vec3)，名字与类型都不一样，防手滑。
//     实测 bridge_underpass：R.row2 = [0, +0.7071, +0.7071]，M.row2 = [0, −0.7071, −0.7071]，
//     即 M_lab = diag(1,1,−1) · R_game。把任一个喂给另一个的消费者 = Z 轴整体翻号。
//
// 【设计铁律 4】两套像素栅格永远不许混。
//   · native px  = 背景原生分辨率（background.png / raw_depth_rg.png，实测 2048×1143）
//     配 depthConfig.M 的 {ppu, cx, cy}（实测 450.56 / 1024 / 571.5）。
//     换算比例 = SceneManager 的 worldToPixelX/Y。
//   · work px    = 照明载荷工作分辨率（lighting.json work，实测 512×286）
//     配 meta.cal 的 {ppu, cx, cy}（雾津街头 112.64 / 256 / 144）。
//     ⚠ **比例不是恒定的 1/4**：28 个场景实测 native/work 从 1.95 到 4.0，
//       只有 19 个恰好是 4。任何「反正是 4 倍」的假设都会在其余 9 个场景上错。
//       但两套各自自洽——尺寸比与 ppu 比在每个场景上都逐位相等（实测）。
//     换算比例 = CharacterLightingSystem 的 worldToWorkX/Y。
//   两套各自自洽，**跨用即错一个整数倍**。本文件把换算拆成两个同体不同名的函数
//   （wrWorldToNativePx / wrWorldToWorkPx），让 code review 一眼能看出配对是否正确。
//
// ---------------------------------------------------------------------------
// 【怎么拼】三段切片，vite ?raw 引入，同一行切片器（wgslChunks.ts 已切好）：
//
//     import WR_WGSL_SRC from './lighting/worldReconstruct.wgsl?raw';
//     const WR_CORE_WGSL   = slice(WR_WGSL_SRC, 'WR_CORE');    // 纯数学，无纹理
//     const WR_TEX_WGSL    = slice(WR_WGSL_SRC, 'WR_TEX');     // 采样封装，依赖 CORE
//     const WR_SPRITE_WGSL = slice(WR_WGSL_SRC, 'WR_SPRITE');  // 直立 quad + 精灵法线，依赖 CORE
//
//   · WGSL 模块级声明与顺序无关，三段谁前谁后都行；但每段在同一模块里只许拼一次。
//   · 整个文件（含三段）也能整份拼（WORLD_RECONSTRUCT_WGSL），切片标记之外只有注释；
//     整份与切片不能在同一模块里同时拼。
//
// 【写法约束（与 master 的 GLSL 版数值不变）】
//   · WR_CONTRACT 是 i32 常量。
//   · WR_TEX 里取样的函数，采样器紧跟它服务的纹理作形参，采样用 textureSampleLevel(…, 0.0)：
//     能在分支 / 循环里调，对单级纹理等价于隐式 LOD。按整数纹素取一律 textureLoad(…, 0)，不需要采样器。
//   · 三元式一律写成 if/else（不用 select：select 两边都求值）。
//   · 精度：RG16 解码要在 [0,65535] 上分辨 1，WGSL 的 f32 天然满足（master 的 GLSL 那边为此要求宿主 highp）。
//
// 【CPU 镜像】src/utils/worldReconstruct.ts 是本文件的逐函数严格镜像，
//   供 SceneDepthSystem.isCollision / CharacterLightingSystem.driveFilter /
//   resolveShadowLights / groundDepthField 使用。两侧共用 worldReconstruct.fixtures.json
//   金标向量；WR_CONTRACT 常量必须两边一致，改了本文件而没改 TS 会让 parity 测试红。
//   >>> 改本文件 = 必须同步改 worldReconstruct.ts，并 bump WR_CONTRACT。<<<
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件的注释里不许出现
//   「at 号 + group / binding + 括号」字样。
// ============================================================================

//__WR_CORE_BEGIN__
// ---------------------------------------------------------------------------
// 契约版本。TS 镜像里有同名同值常量；parity 测试比对两者。
// 语义变更必须 bump，纯注释/纯新增可不 bump。
// ---------------------------------------------------------------------------
const WR_CONTRACT: i32 = 2;

// 各站点原文里的三种下限守卫，原样保留为具名常量（数值不许改，改了就是行为变化）：
//   WR_EPS_PROJ  = max(projectionScale, ·)  —— 4 处站点原文
//   WR_EPS_COSPP = max(cosT * ppu, ·)       —— 2 处着色站点原文
//   WR_EPS_SCENE = max(sceneExtent, ·)      —— EntityShadow.groundDepthAt 原文
//   WR_EPS_TIGHT = max(sceneExtent, ·)      —— CharacterLitSprite ground 原文
//   （两个 extent epsilon 只在 sceneExtent≈0 时才有分别，现役 28 张场景的 worldWidth/Height
//    都在 1e3 量级 → 统一成谁都是零行为变化。P1 收敛到 WR_EPS_SCENE。）
const WR_EPS_PROJ: f32 = 1e-6;
const WR_EPS_COSPP: f32 = 1e-6;
const WR_EPS_SCENE: f32 = 1e-3;
const WR_EPS_TIGHT: f32 = 1e-5;

// ===========================================================================
// 1. 屏幕/几何 → 场景世界坐标
//    产出的 (wx, wy) 是**场景世界单位**,原点=世界左上,**Y 仍向下**(全程不翻)。
//    翻 Y 只发生在后面 wrQy 那一步(cy − sy),别提前翻。
// ===========================================================================

/**
 * 滤镜路径:全局屏幕像素 → 场景世界坐标。
 * 原文(逐字等价):
 *   float S  = max(uProjectionScale, 1e-6);
 *   float wx = (vScreenPos.x - uWorldContainerPos.x) / S;
 *   float wy = (vScreenPos.y - uWorldContainerPos.y) / S;
 * 站点:DepthOcclusionFilter:67-72 / EntityLightingFilter:116-118 /
 *       CharacterShadingFilter:325-327 / CharacterLitSprite VERT:56-57。
 */
fn wrScreenToWorld(screenPos: vec2<f32>, worldContainerPos: vec2<f32>, projectionScale: f32) -> vec2<f32> {
    let S = max(projectionScale, WR_EPS_PROJ);
    return (screenPos - worldContainerPos) / S;
}

/**
 * 场景归一化 UV(深度图 / 背景 / 行走面场共用同一套寻址)。
 * v **不翻转**,与世界 Y 同向。
 *
 * ⚠ \`extent\` 的单位由调用方决定,本函数只做除法:
 *    · 遮挡/着色/影子路径喂**世界单位** sceneW/sceneH;
 *    · BackgroundDebugFilter 喂的是**屏幕像素** (worldW·S, worldH·S),而它的分子
 *      也是未除 S 的屏幕位移 —— 两者约掉 S,结果与前者代数相同。这不是 bug,
 *      但同名 uniform 两种单位是货真价实的坑,迁移时请把该 uniform 更名为
 *      uSceneSizeScreenPx(纯改名,零行为变化)。
 * ⚠ 无除零守卫:extent=0 → ±Inf/NaN。是否需要守卫由站点用 wrSceneUvGuarded 决定
 *    (原文里遮挡路径就是裸除,保持不变)。
 * 站点:DepthOcclusionFilter:75 / EntityLightingFilter:123 / CharacterShadingFilter:332 /
 *       EntityShadow:130 / BackgroundDebugFilter:100。
 */
fn wrSceneUv(p: vec2<f32>, extent: vec2<f32>) -> vec2<f32> {
    return p / extent;
}

/** 带下限守卫 + 钳制的版本(行走面场寻址用)。eps 传 WR_EPS_SCENE 或 WR_EPS_TIGHT。 */
fn wrSceneUvGuarded(p: vec2<f32>, extent: vec2<f32>, eps: f32) -> vec2<f32> {
    return clamp(p / max(extent, vec2<f32>(eps)), vec2<f32>(0.0), vec2<f32>(1.0));
}

/**
 * UV 是否落在 [0,1]²(**NaN → false = 出界**,推荐口径)。
 * 原文:EntityLightingFilter:124 / CharacterShadingFilter:333 / BackgroundDebugFilter:138
 *       (碰撞格版)全部是这个正向写法。
 */
fn wrUvInside(uv: vec2<f32>) -> bool {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

/**
 * 反向写法,**仅为逐字复刻 DepthOcclusionFilter:78 与 EntityShadow:99 保留**。
 * 与 wrUvInside 在有限输入下互为补集,但 **NaN 时两者都返回 false** —— 即
 * \`!wrUvOutside(NaN)\` = true(继续采样,踩 NaN 陷阱),而 \`wrUvInside(NaN)\` = false(跳过)。
 * 新代码一律用 wrUvInside;这个函数只在需要"字节级不变"的迁移期用。
 */
fn wrUvOutside(uv: vec2<f32>) -> bool {
    return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
}

// ===========================================================================
// 2. 世界 → 像素栅格
//    两个函数体完全一样,**名字就是类型系统**:选错名字 = 选错标定 = 错一个整数倍。
// ===========================================================================

/** 世界 → **native px**(背景原生分辨率)。必须配 depthConfig.M 的 {ppu,cx,cy}。 */
fn wrWorldToNativePx(worldXY: vec2<f32>, worldToNativePx: vec2<f32>) -> vec2<f32> {
    return worldXY * worldToNativePx;
}

/** 世界 → **work px**(照明载荷分辨率)。必须配 meta.cal 的 {ppu,cx,cy}。 */
fn wrWorldToWorkPx(worldXY: vec2<f32>, worldToWorkPx: vec2<f32>) -> vec2<f32> {
    return worldXY * worldToWorkPx;
}

// ===========================================================================
// 3. 像素栅格 → 伪世界 q
//    契约:q = ( (sx − cx)/ppu , (cy − sy)/ppu , d )
//    · x 不翻号,先减主点再除 ppu;
//    · y **翻 Y**:是 (cy − sy) 不是 (sy − cy) —— 屏幕 Y 向下、伪世界 Y 向上;
//    · z 是深度 d,**不除 ppu**、不减任何主点、不乘任何系数。
// ===========================================================================

/** q.x。站点:EntityShadow:93 / BackgroundDebugFilter:128 / CharacterShadingFilter:366 /
 *  CharacterLitSprite:101,111 / SceneDepthSystem.isCollision:372(CPU)。 */
fn wrQx(sxPx: f32, ppu: f32, cx: f32) -> f32 {
    return (sxPx - cx) / ppu;
}

/** q.y(**翻 Y 就在这里**)。站点:EntityShadow:94 / BackgroundDebugFilter:129 /
 *  CharacterLitSprite:102 / SceneDepthSystem.isCollision:373(CPU) /
 *  CharacterLightingSystem.driveFilter:916(CPU)。 */
fn wrQy(syPx: f32, ppu: f32, cy: f32) -> f32 {
    return (cy - syPx) / ppu;
}

/** 完整 q。d 原样进 z。 */
fn wrPixelToQ(pxXY: vec2<f32>, ppu: f32, cx: f32, cy: f32, d: f32) -> vec3<f32> {
    return vec3<f32>(wrQx(pxXY.x, ppu, cx), wrQy(pxXY.y, ppu, cy), d);
}

// ---- 逆变换（q → 像素）。收编前只在 probeViz / lightsQ 两处内联手写过，
//      而那两处恰恰最容易把 lab M(det=−1)与 native/work 两套栅格搞串。
//      沿光线 march 深度场时每一步都要用，所以必须在这里，不能再散出去。----

/** \`wrQx\` 的逆。 */
fn wrQxToPx(qx: f32, ppu: f32, cx: f32) -> f32 {
    return cx + qx * ppu;
}

/** \`wrQy\` 的逆（同样翻 Y）。 */
fn wrQyToPx(qy: f32, ppu: f32, cy: f32) -> f32 {
    return cy - qy * ppu;
}

/** q → 像素坐标。 */
fn wrQToPixel(q: vec3<f32>, ppu: f32, cx: f32, cy: f32) -> vec2<f32> {
    return vec2<f32>(wrQxToPx(q.x, ppu, cx), wrQyToPx(q.y, ppu, cy));
}

// ===========================================================================
// 4. 伪世界 q → M-world  (depthConfig.M.R,**det = +1**)
//    world = R · q,R 行主。这里刻意不用 mat3:6 处站点里有 3 处只上传了 R 的
//    第 0 行与第 2 行(世界 Y 高度它们根本不用),硬凑 mat3 会逼人补上没有的数据。
// ===========================================================================

/** (R·q).x —— 表达式树与站点原文 \`R00*px + R01*py + R02*d\` 完全一致。 */
fn wrQToWorldRow(row: vec3<f32>, q: vec3<f32>) -> f32 {
    return row.x * q.x + row.y * q.y + row.z * q.z;
}

/** 只要水平面 (X, Z):碰撞格反投影用。站点:EntityShadow:95-96 /
 *  BackgroundDebugFilter:131-132 / SceneDepthSystem.isCollision:375-376(CPU)。 */
fn wrQToWorldXZ(r0: vec3<f32>, r2: vec3<f32>, q: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(wrQToWorldRow(r0, q), wrQToWorldRow(r2, q));
}

/** 完整 M-world。现役无消费者(DeferredEntityShadow 是死码;它按**列**取 R,
 *  展开后与本函数逐项相同,但它把 lab 的角度约定当 M-world 用 —— 见文件尾注 D-DEAD)。 */
fn wrQToWorld(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, q: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(wrQToWorldRow(r0, q), wrQToWorldRow(r1, q), wrQToWorldRow(r2, q));
}

/**
 * 上者的逆:M-world → 伪世界 q。R 正交(实测 |RᵀR−I| ≤ 1.11e-16,28/28 场景),
 * 所以转置即逆 —— 按**列**取,即 (Rᵀ·w)[i] = r0[i]·w.x + r1[i]·w.y + r2[i]·w.z。
 *
 * ⚠ 这个方向一度**只有 CPU 侧有**(worldReconstruct.ts 的 wrWorldToQComponent),
 *   着色器侧(当时的 GLSL)全是单向的。于是 2026-08-22 有人在场景 pass 里内联写了个 lightToQ,
 *   随后清理死代码时被一并删掉 —— 调用还在、定义没了,**整个重打光 shader 编译失败**,
 *   28 个场景的背景全黑。而全部门都绿:lint 只做字符串包含,没有一处真编译 GLSL。
 *   补在这里,两个方向就都有唯一真源了。
 *
 * 用途:把灯位从 M-world 折回 q(阴影的线扫前缀、光晕的视线积分都要)。
 */
fn wrWorldToQ(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, w: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        r0.x * w.x + r1.x * w.y + r2.x * w.z,
        r0.y * w.x + r1.y * w.y + r2.y * w.z,
        r0.z * w.x + r1.z * w.y + r2.z * w.z);
}

/**
 * ⚠⚠ **另一个 M**:实验室 lighting.json 的 world.M,**det = −1**(GL 右手,Z 反号)。
 * 只服务 probe/体素晶格查表(CharacterShadingFilter.ts:282 的 \`vec3 Xw = uM * q;\`)。
 * 与上面 wrQToWorld* 一族**不可互换**:把它的结果喂进碰撞格 = Z 轴整体翻号。
 * mat3x3 是列主(WGSL 与 master 的 GLSL 相同),CPU 侧上传的 mCol 已按列展开(CharacterLightingSystem),
 * 故 \`M * q\` 等于「meta.world.M 行 · q」。
 */
fn wrQToProbeWorld(labWorldM: mat3x3<f32>, q: vec3<f32>) -> vec3<f32> {
    return labWorldM * q;
}

// ===========================================================================
// 5. M-world 水平面 → 碰撞格
//    连续格坐标(**不 floor、不加半格**),边界判据是半开区间 [0, grid)。
// ===========================================================================

/** 站点:EntityShadow:97-98 / BackgroundDebugFilter:134-135 / isCollision:378-379(CPU,后接 floor)。 */
fn wrWorldXZToCell(worldXZ: vec2<f32>, cellMinXZ: vec2<f32>, cellSize: f32) -> vec2<f32> {
    return (worldXZ - cellMinXZ) / cellSize;
}

/** 格坐标是否在网格内(**NaN → false**,推荐口径;BackgroundDebugFilter:138 原文就是这个)。 */
fn wrCellInside(cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    return cell.x >= 0.0 && cell.x < gridSize.x && cell.y >= 0.0 && cell.y < gridSize.y;
}

/** 反向写法,仅为逐字复刻 EntityShadow:99。NaN 语义与 wrCellInside 不同,见 wrUvOutside 的说明。 */
fn wrCellOutside(cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    return cell.x < 0.0 || cell.x >= gridSize.x || cell.y < 0.0 || cell.y >= gridSize.y;
}

// ===========================================================================
// 6. RG16 解码 —— **两族,不可混用**
//    共同前半段:t = (r·255·256 + g·255) / 65535 ∈ [0,1](R = 高字节)。
//    · depth_map 族:  d = (invert ? 1−t : t) · scale + offset   ← 有 invert/scale/offset
//    · ground_d 族:   d = min + t · (max − min)                 ← **没有 invert**,
//                        用的是 lighting.json 的 ground_d.min/max,与 depth_mapping 无关。
//    两族解出的 d 同量纲(实验室 q 空间深度,越小越近),这一点**只靠烘焙保证**,
//    运行时无交叉校验 —— 见 TS 侧 assertCalibrationCoherence()。
// ===========================================================================

/** 归一化 t。逐字等价于 6 处站点的 \`(s.r*255.0*256.0 + s.g*255.0)/65535.0\`。 */
fn wrDecodeRG16Unit(texel: vec4<f32>) -> f32 {
    return (texel.r * 255.0 * 256.0 + texel.g * 255.0) / 65535.0;
}

/** depth_map 族。invert 作用在**归一化 t** 上,先于 scale/offset。 */
fn wrDecodeSceneDepth(texel: vec4<f32>, invert: f32, scale: f32, offset: f32) -> f32 {
    let rawDepth = wrDecodeRG16Unit(texel);
    var d_raw = rawDepth;
    if (invert > 0.5) { d_raw = 1.0 - rawDepth; }
    return d_raw * scale + offset;
}

/** ground_d 族。range = vec2(min, max)。**不吃 invert / scale / offset。** */
fn wrDecodeGroundDepth(texel: vec4<f32>, range: vec2<f32>) -> f32 {
    return range.x + wrDecodeRG16Unit(texel) * (range.y - range.x);
}

// ===========================================================================
// 7. 精灵深度代理(遮挡判据) —— 「立在伪世界里的直立 quad」
//    depth_per_sy ≡ tanθ/ppu_native,是把「整套 M 反投影 + 沿直立面抬升」
//    折叠成的一维梯度。代数等价证明(与第 8 节的完整式对照):
//        h    = (footSy − sy) / (cosθ · ppu)
//        q.z  = footQ.z − h·sinθ
//             = footQ.z + (tanθ/ppu)·(sy − footSy)
//             = footDepthQ + depth_per_sy·(syTex − syTexFoot)
//    实测 bridge_underpass:θ=45°(R.row1=[0,.7071,−.7071])、M.ppu=450.56 →
//        tan45/450.56 = 0.00221946 == JSON 的 depth_per_sy 0.002219460227272727 ✓
//    ⚠ 所以 depth_per_sy **是 M 的函数**。改了 M.ppu/θ 而没重烘 depth_per_sy = 静默错到底。
//      TS 侧 resolveDepthPerSy() 负责在装载期断言这条恒等式。
// ===========================================================================

/**
 * 直立 quad 的深度增量,单位 = q 空间深度。
 * 符号:像素在脚点**上方** → syTex < syTexFoot → 返回负值 → 更靠近相机。
 * ⚠ **不钳非负**(与第 8 节的 wrUprightHeight 相反):脚点下方的像素会得到正值、被推远。
 *   三处遮挡站点原文都不钳,这里照搬。两条路对同一片元用不同 q.z 是已知分叉(见 D-08)。
 * 站点:DepthOcclusionFilter:93-95 / EntityLightingFilter:132-134 / CharacterShadingFilter:342-344。
 */
fn wrUprightDelta(worldY: f32, footWorldY: f32, worldToNativePxY: f32, depthPerSy: f32) -> f32 {
    let syTexFoot = footWorldY * worldToNativePxY;
    let syTex = worldY * worldToNativePxY;
    return depthPerSy * (syTex - syTexFoot);
}

/**
 * 精灵深度代理。加法顺序即三处站点原文顺序,不许重排(浮点结合律)。
 *   footDepthQ + upright + floorOffset + floorOffsetExtra − footBias
 * 语义:floorOffset / floorOffsetExtra 为正 = 推远 = 更易被遮;footBias 为正 = 拉近 = 更不易被遮。
 * 影子路径只有 (ground + floorOffset),用 wrSpriteDepth(g, 0.0, floorOffset, 0.0, 0.0) 精确复现
 * (x+0.0 与 x−0.0 对非 −0 的 x 都是恒等)。
 */
fn wrSpriteDepth(footDepthQ: f32, upright: f32, floorOffset: f32,
                 floorOffsetExtra: f32, footBias: f32) -> f32 {
    return footDepthQ + upright + floorOffset + floorOffsetExtra - footBias;
}

/**
 * 遮挡判据。容差加在**场景**一侧,严格小于。
 * true = 场景几何比精灵更靠近相机 = 精灵被前景挡住。
 */
fn wrIsOccluded(sceneDepth: f32, spriteDepth: f32, tolerance: f32) -> bool {
    return sceneDepth + tolerance < spriteDepth;
}

/**
 * 遮挡像素的预乘输出。**rgb 与 a 必须同乘同一系数** —— 只乘 a 会让预乘合成按完整 rgb
 * 参与 blend,画面发白(DepthOcclusionFilter.ts:108-109 的实证注释)。
 * blend < 1e-5 的 discard 分支留在站点(本文件不做控制流)。
 */
fn wrApplyOcclusionBlend(premultipliedColor: vec4<f32>, blend: f32) -> vec4<f32> {
    return vec4<f32>(premultipliedColor.rgb * blend, premultipliedColor.a * blend);
}
//__WR_CORE_END__

//__WR_TEX_BEGIN__
// ===========================================================================
// 8. 采样封装(依赖 CORE,要一起拼进同一模块)。纹理与采样器都是形参;采样器紧跟它服务的那张纹理。
// ===========================================================================

/** 深度图直采 + 解码。站点:三个遮挡滤镜、EntityShadow:132-135、BackgroundDebugFilter:109-112。 */
fn wrSampleSceneDepth(depthMap: texture_2d<f32>, depthSmp: sampler, uv: vec2<f32>,
                      invert: f32, scale: f32, offset: f32) -> f32 {
    return wrDecodeSceneDepth(textureSampleLevel(depthMap, depthSmp, uv, 0.0), invert, scale, offset);
}

/** 行走面场按**已算好的 UV** 直采(BackgroundDebugFilter:125-127 复用外层 uv)。 */
fn wrSampleGroundAtUv(groundTex: texture_2d<f32>, groundSmp: sampler, uv: vec2<f32>, range: vec2<f32>) -> f32 {
    return wrDecodeGroundDepth(textureSampleLevel(groundTex, groundSmp, uv, 0.0), range);
}

/**
 * 行走面场按**世界坐标**直采(带守卫 + 钳制)。
 * eps 传 WR_EPS_SCENE 复现 EntityShadow:83-86,传 WR_EPS_TIGHT 复现 CharacterLitSprite:103-106。
 * ⚠ 纹理是 scaleMode:'nearest'(CharacterLightingSystem.ts:712),所以这是**最近邻**;
 *   而 CPU 侧 sampleGroundField 是**双线性** —— 这是 GPU/CPU 之间最实的一条数值分叉(D-11)。
 *   P1 的收敛落点是下面的 wrSampleGroundWorldBilinear。
 */
fn wrSampleGroundWorld(groundTex: texture_2d<f32>, groundSmp: sampler, worldXY: vec2<f32>, sceneExtent: vec2<f32>,
                       range: vec2<f32>, eps: f32) -> f32 {
    return wrSampleGroundAtUv(groundTex, groundSmp, wrSceneUvGuarded(worldXY, sceneExtent, eps), range);
}

/**
 * [P1,现役未启用] 行走面场双线性 —— 与 CPU 版 sampleGroundField 严格同源。
 * 逐行复刻 src/utils/groundDepthField.ts:29-37,包括:
 *   · 钳制在插值**之前**,上界是 (size − 1.001) 不是 (size − 1);
 *   · i11 写作 i01 + 1(CPU 原文如此;因 x0 ≤ w−2,不会跨行,合法)。
 * 前提:groundTex 必须是 nearest 且未预乘(现役已满足),否则 textureLoad 之外的路径会二次插值。
 * ⚠ 启用它会改变影子边缘与 F2 碰撞图 —— 属于「修 CPU/GPU 分叉」,不是零变化。
 */
fn wrSampleGroundWorldBilinear(groundTex: texture_2d<f32>, texSize: vec2<f32>, worldXY: vec2<f32>,
                               sceneExtent: vec2<f32>, range: vec2<f32>) -> f32 {
    let p = (worldXY / max(sceneExtent, vec2<f32>(WR_EPS_SCENE))) * texSize;
    let pc = clamp(p, vec2<f32>(0.0), texSize - 1.001);
    let b = floor(pc);
    let f = pc - b;
    let i00 = vec2<i32>(b);
    let d00 = wrDecodeGroundDepth(textureLoad(groundTex, i00, 0), range);
    let d10 = wrDecodeGroundDepth(textureLoad(groundTex, i00 + vec2<i32>(1, 0), 0), range);
    let d01 = wrDecodeGroundDepth(textureLoad(groundTex, i00 + vec2<i32>(0, 1), 0), range);
    let d11 = wrDecodeGroundDepth(textureLoad(groundTex, i00 + vec2<i32>(1, 1), 0), range);
    return d00 * (1.0 - f.x) * (1.0 - f.y) + d10 * f.x * (1.0 - f.y)
         + d01 * (1.0 - f.x) * f.y + d11 * f.x * f.y;
}

/**
 * 碰撞格采样(现役口径:连续 UV + 纹理默认 linear 过滤 + 阈值 0.5)。
 * 站点:EntityShadow:97-100 / BackgroundDebugFilter:134-141。
 * ⚠ 与 CPU 版 isCollision(floor 定格 + 原始字节 >127)**不是同一条边界**:
 *   linear 过滤会把二值图边界抹圆并整体挪半格(D-12)。P1 落点见下一个函数。
 */
fn wrSampleCollisionCell(collisionMap: texture_2d<f32>, collisionSmp: sampler, cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return textureSampleLevel(collisionMap, collisionSmp, cell / gridSize, 0.0).r > 0.5;
}

/**
 * [P1,现役未启用] 碰撞格采样,与 CPU isCollision 严格同源:floor 定格 + textureLoad。
 * 阈值 0.5 与 CPU 的 \`byte > 127\` 对整数字节完全等价(127/255=0.498 < 0.5 < 0.502=128/255)。
 * 前提:collisionMap 需设 scaleMode:'nearest'(现役是 Pixi 默认 linear)。
 * ⚠ 启用会让影子裁切边界与 F2 碰撞图整体挪半格并变硬 —— 是「与玩家实际能不能走过去对齐」,
 *   但确实改表现。
 */
fn wrSampleCollisionCellNearest(collisionMap: texture_2d<f32>, cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return textureLoad(collisionMap, vec2<i32>(floor(cell)), 0).r > 0.5;
}
//__WR_TEX_END__

//__WR_SPRITE_BEGIN__
// ===========================================================================
// 9. 直立 quad 的完整式(着色路径)+ 精灵法线解码
//    与第 7 节是**同一个几何的两种写法**:第 7 节把 (翻Y + 除ppu + tanθ) 折成一个标量,
//    这里保留三步。二者在 h > 0 的区域代数等价;h 被钳 0 的区域(脚点下方)不等价。
//    ⚠ 本节用的是 **work px + meta.cal**,第 7 节用的是 **native px + depthConfig.M**。
// ===========================================================================

/**
 * 像素相对脚点的直立高度(世界单位),脚点下方**钳 0**。
 * 逐字等价:max((footSyPx − pixelSyPx) / max(cosT * ppu, 1e-6), 0.0)
 * ⚠ 减法顺序是 (脚点 − 本像素),与第 7 节 wrUprightDelta 的 (本像素 − 脚点) **相反**
 *   —— 两者各自正确(输出量的符号约定相反),但并排读极易抄错。
 * 站点:CharacterShadingFilter:367 / CharacterLitSprite:110。
 */
fn wrUprightHeight(pixelSyPx: f32, footSyPx: f32, cosT: f32, ppu: f32) -> f32 {
    return max((footSyPx - pixelSyPx) / max(cosT * ppu, WR_EPS_COSPP), 0.0);
}

/**
 * 着色路径的最终 q。
 *   q = ( qx , footQy + h·cosθ , footQz − h·sinθ − bulge )
 * bulge 实参传 \`ne.a * uBulge\`(法线图 alpha 通道的鼓包),这样表达式树 ((a−b)−c) 与原文一致。
 * 恒等:h·cosθ = (footSy − sy)/ppu,故在 h>0 区域 q.y ≡ (cy − sy)/ppu,与 wrQy 契约一致。
 * ⚠ 这里的 q.z **不是** 第 7 节的 spriteDepth:前者含 bulge、不含 floorOffset/footBias,
 *   后者反之。刻意如此(遮挡代理 vs 着色代理),不要"统一"。
 * 站点:CharacterShadingFilter:394-396 / CharacterLitSprite:120。
 */
fn wrQFromFoot(qx: f32, footQy: f32, footQz: f32, h: f32,
               cosT: f32, sinT: f32, bulge: f32) -> vec3<f32> {
    return vec3<f32>(qx, footQy + h * cosT, footQz - h * sinT - bulge);
}

/**
 * 精灵法线解码(两处着色站点逐字相同)。
 *   · rgb 三个分量**全部取负**;b 先 max(·,0.05) 再取负(z 恒指向相机)
 *   · 镜像只翻 n.x
 *   · 向 (0,0,−1) 压平
 * 无法线图时调用方应传 ne = vec4(0.5, 0.5, 1.0, 0.35)(**常量兜底**,
 * 不是去采 Texture.WHITE —— 采白图会得 ne=(1,1,1,1) → n=normalize(−1,−1,−1),完全错的方向)。
 * 站点:CharacterShadingFilter:390-392 / CharacterLitSprite:116-118。
 */
fn wrDecodeSpriteNormal(ne: vec4<f32>, mirrored: bool, flatten: f32) -> vec3<f32> {
    var n = normalize(vec3<f32>(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (mirrored) { n.x = -n.x; }
    return normalize(mix(n, vec3<f32>(0., 0., -1.), flatten));
}
//__WR_SPRITE_END__

// ============================================================================
// 尾注:收编后**仍然存在**的差异,别以为统一了源码就统一了口径
//
// D-08  遮挡代理不钳 h、着色代理钳 h≥0 → 脚点下方的像素在两条路上 q.z 不同。
//       现役如此,统一源如实保留(wrUprightDelta 不钳 / wrUprightHeight 钳)。
// D-11  行走面场:GPU nearest vs CPU 双线性,差最多一个 work texel 的地面深度。
//       P1 用 wrSampleGroundWorldBilinear 收敛到 CPU 口径(isCollision 是 audit 裁决基准)。
// D-12  碰撞格:GPU 连续 UV+linear vs CPU floor+>127,差半格且边界被抹圆。
//       P1 用 wrSampleCollisionCellNearest 收敛到 CPU 口径。
// D-DEAD DeferredEntityShadow(死码)的 reconstruct 本体与本文件逐项相同(它按列取 R,
//       展开后等价),被废掉的是它**周围**:光向把 env.key.azimuthDeg(屏幕平面角契约)
//       当 M-world XZ 方位用、脚点深度采的是 depth_map 而非 ground_d、丢了 floorOffset/
//       footBias/tolerance、没有碰撞裁切与 uShadowColor。不适配它;若日后复活,
//       必须把光向先经 R 从 q 空间转到 M-world,并改用 wrSampleGroundWorld*。
// ============================================================================
`;function Ru(e,t){let n=`//__${t}_BEGIN__`,r=`//__${t}_END__`,i=e.indexOf(n),a=e.indexOf(r);if(i<0||a<0)throw Error(`[wgslChunks] WGSL 缺切片标记 ${t}`);return e.substring(i+n.length,a)}var zu=Ru(Lu,`WR_CORE`);Ru(Lu,`WR_TEX`),Ru(Lu,`WR_SPRITE`),[`
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}

struct EntityShade {
    uHasNrm: f32,
    uBodyWidthWu: f32,
    uL2W0: vec3<f32>,
    uL2W1: vec3<f32>,
}

struct SceneShade {
    uWorkSize: vec2<f32>,
    uWorldToWork: vec2<f32>,
    uCal: vec4<f32>,
    uCosT: f32,
    uSinT: f32,
    uQMin: vec3<f32>,
    uQMax: vec3<f32>,
    uVolN: vec3<f32>,
    uVolTiles: vec2<f32>,
    uM: mat3x3<f32>,
    uWMin: vec3<f32>,
    uWScale: vec3<f32>,
    uPN: vec3<f32>,
    uProbeT: f32,
    uShK: f32,
    uBinOb: f32,
    uAmbSH: array<vec3<f32>, 9>,
    uLightQ: array<vec4<f32>, 48>,
    uLightE: array<vec4<f32>, 48>,
    uLightCount: f32,
    uGroundRange: vec2<f32>,
    uSceneWorld: vec2<f32>,
    uSkyaoN: vec3<f32>,
    uSkyaoTiles: vec2<f32>,
    uSkyaoMin: vec3<f32>,
    uSkyaoScale: vec3<f32>,
    uSkyaoM: mat3x3<f32>,
    uSkyaoOn: f32,
}


struct FrameShade {
    uWCPos: vec2<f32>,
    uWCScale: f32,
    uMode: f32,
    uSpp: f32,
    uMSteps: f32,
    uFold: f32,
    uMissMode: f32,
    uNEE: f32,
    uStep: f32,
    uBeta: f32,
    uIndirectFactor: f32,
    uDirectFactor: f32,
    uTotalFactor: f32,
    uAmbStrength: f32,
    uBulge: f32,
    uFlatten: f32,
    uShowN: f32,
    uEOnly: f32,
    uGiStrength: f32,
    uFixedNQ: f32,
    uEChecker: f32,
    uSunOn: f32,
    uSunDirQ: vec3<f32>,
    uSunColor: vec3<f32>,
    uEChroma: f32,
    uAOContact: f32,
    uAOForm: f32,
    uSkyaoBlend: f32,
}


struct CharLights {
    uSceneLightCount: i32,
    uSceneLightA: array<vec4<f32>, 24>,
    uSceneLightB: array<vec4<f32>, 24>,
    uSceneLightC: array<vec4<f32>, 24>,
    uSceneLightD: array<vec4<f32>, 24>,
    uSMWuPerQUnit: f32,
    uSMRow0: vec3<f32>,
    uSMRow1: vec3<f32>,
    uSMRow2: vec3<f32>,
    uDispEv: f32,
    uDispTonemap: i32,
    uDispWhite: vec3<f32>,
    uDispSaturation: f32,
    uDispContrast: f32,
    uDispLift: f32,
    uDispLiftColor: vec3<f32>,
}

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

@group(2) @binding(0) var<uniform> sceneShade: SceneShade;
@group(2) @binding(1) var<uniform> frameShade: FrameShade;
@group(2) @binding(2) var<uniform> charLights: CharLights;
@group(2) @binding(3) var<uniform> entityShade: EntityShade;
@group(2) @binding(4) var uColorTex: texture_2d<f32>;
@group(2) @binding(5) var uColorTexSampler: sampler;
@group(2) @binding(6) var uNrm: texture_2d<f32>;
@group(2) @binding(7) var uNrmSampler: sampler;
@group(2) @binding(8) var uGround: texture_2d<f32>;
@group(2) @binding(9) var uGroundSampler: sampler;
@group(2) @binding(10) var uPL1: texture_2d<f32>;
@group(2) @binding(11) var uPL2: texture_2d<f32>;
@group(2) @binding(12) var uPBin: texture_2d<f32>;
@group(2) @binding(13) var uValid: texture_2d<f32>;
@group(2) @binding(14) var uVolRad: texture_2d<f32>;
@group(2) @binding(15) var uVolEmit: texture_2d<f32>;
@group(2) @binding(16) var uSkyaoTex: texture_2d<f32>;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vLocal: vec2<f32>,
    @location(2) vWorld: vec2<f32>,
    @location(3) vFootWorld: vec2<f32>,
    @location(4) vMirror: f32,
    @location(5) vColor: vec4<f32>,
}
`,Pu,zu,Ru(Iu,`LIGHTING_CORE`),`
/** 面光两条半轴。与 SceneLightingPass 的同名函数同式（绕法线自转 roll）。 */
fn litAreaAxes(n: vec3<f32>, halfW: f32, halfH: f32, roll: f32,
               halfU: ptr<function, vec3<f32>>, halfV: ptr<function, vec3<f32>>) {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(n.y) > 0.95) { up = vec3<f32>(1.0, 0.0, 0.0); }
    let u = normalize(cross(up, n));
    let v = cross(n, u);
    let c = cos(roll);
    let s = sin(roll);
    *halfU = (u * c + v * s) * halfW;
    *halfV = (v * c - u * s) * halfH;
}

/**
 * q = 伪世界点；n = **世界**法线（已在 M-world）。返回各盏灯的照度之和。
 *
 * 铁律 0（制作人 2026-08-30 定死）：光照一律在**世界空间、单位 wu**。
 * 朝向过 R、尺度过 uSMWuPerQUnit，一次转到底 —— 不许停在「世界朝向 + q 尺度」
 * 那个没有名字的中间态：那会让 range / 软化半径 / 面光尺寸在 shader 里不是 wu，
 * 而作者面明明按 wu 填，读代码的人无法判断某个长度是哪把尺。
 * 法线直接用 n：调用方交进来的**已经是世界法线** —— 世界对世界，谁都不用转。
 */
fn entitySceneLightsE(q: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    var E = vec3<f32>(0.0);
    if (charLights.uSceneLightCount <= 0) { return E; }
    let P = wrQToWorld(charLights.uSMRow0, charLights.uSMRow1, charLights.uSMRow2, q) * charLights.uSMWuPerQUnit;
    for (var i = 0; i < 24; i++) {
        if (i >= charLights.uSceneLightCount) { break; }
        let A = charLights.uSceneLightA[i];
        let B = charLights.uSceneLightB[i];
        let C = charLights.uSceneLightC[i];
        let D = charLights.uSceneLightD[i];
        if (B.w <= 0.0) { continue; }             // 强度 0 的灯贡献恒等于 0
        let kind = i32(A.w + 0.5);
        let flags = i32(D.w + 0.5);               // bit0=castShadow bit1=twoSided
        // 实体不吃灯的阴影：投影解是场景那一级按背景像素栅格解的前缀最小，
        // 角色 / 粒子是动的、不在那张图里。vis 恒 1，宁可多一点光也不要错位的黑块。
        if (kind == LC_POINT) {
            E += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, 1.0);
        } else if (kind == LC_SPOT) {
            E += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, 1.0);
        } else if (kind == LC_AREA) {
            var hu: vec3<f32>;
            var hv: vec3<f32>;
            litAreaAxes(normalize(D.xyz), C.z, C.w, C.y, &hu, &hv);
            E += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, 1.0);
        } else if (kind == LC_LINE) {
            // 落雷的雷身（运行时线光）：雷旁边的人与粒子被沿着整道雷身照亮
            E += lcLineLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, 1.0);
        } else {
            E += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
        }
    }
    return E;
}
`,`
@vertex
fn mainVertex(
    @location(0) aPosition: vec2<f32>,
    @location(1) aUV: vec2<f32>,
    @location(2) aLocal: vec2<f32>,
) -> VSOutput {
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
    var out: VSOutput;
    out.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
    out.vUV = aUV;
    out.vLocal = aLocal;
    let r0 = entityShade.uL2W0;
    let r1 = entityShade.uL2W1;
    out.vWorld = vec2<f32>(r0.x * aPosition.x + r0.y * aPosition.y + r0.z,
                           r1.x * aPosition.x + r1.y * aPosition.y + r1.z);
    out.vFootWorld = vec2<f32>(r0.z, r1.z);                  // local 原点(锚点=脚底)的世界坐标
    // 镜像判定:仿射 2x2 行列式,scale.x<0 → det<0(语义与旧 model 判定一致;1 = 几何被镜像)
    let det = r0.x * r1.y - r1.x * r0.y;
    out.vMirror = 0.0;
    if (det < 0.0) { out.vMirror = 1.0; }
    out.vColor = localUniforms.uColor;
    return out;
}
`,`
@fragment
fn mainFragment(
    @builtin(position) fragPos: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vLocal: vec2<f32>,
    @location(2) vWorld: vec2<f32>,
    @location(3) vFootWorld: vec2<f32>,
    @location(4) vMirror: f32,
    @location(5) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
    let color = textureSample(uColorTex, uColorTexSampler, vUV);
    if (color.a < 0.03) { discard; }

    // 公共块的参数结构:按字段名逐个赋值(同为 f32 的字段位置构造会静默错位)
    var pp: ClcProbe;
    pp.uM = sceneShade.uM;
    pp.uWMin = sceneShade.uWMin;
    pp.uWScale = sceneShade.uWScale;
    pp.uPN = sceneShade.uPN;
    pp.uProbeT = sceneShade.uProbeT;
    pp.uShK = sceneShade.uShK;
    pp.uBinOb = sceneShade.uBinOb;
    pp.uFold = frameShade.uFold;
    pp.uAmbSH = sceneShade.uAmbSH;
    pp.uMode = frameShade.uMode;
    pp.uAmbStrength = frameShade.uAmbStrength;
    var sk: ClcSkyao;
    sk.uSkyaoN = sceneShade.uSkyaoN;
    sk.uSkyaoTiles = sceneShade.uSkyaoTiles;
    sk.uSkyaoMin = sceneShade.uSkyaoMin;
    sk.uSkyaoScale = sceneShade.uSkyaoScale;
    sk.uSkyaoM = sceneShade.uSkyaoM;
    sk.uSkyaoOn = sceneShade.uSkyaoOn;

    // ---------- 脚点 q(几何直出 + ground 场采样,零 CPU 驱动) ----------
    let ppu = sceneShade.uCal.x;
    let fw = vFootWorld * sceneShade.uWorldToWork;               // 脚点 → work px
    let qxF = (fw.x - sceneShade.uCal.z) / ppu;
    let qyF = (sceneShade.uCal.w - fw.y) / ppu;
    let guv = clamp(vFootWorld / max(sceneShade.uSceneWorld, vec2<f32>(1e-5)), vec2<f32>(0.0), vec2<f32>(1.0));
    let gs = textureSampleLevel(uGround, uGroundSampler, guv, 0.0);
    let footD = sceneShade.uGroundRange.x
      + ((gs.r * 255.0 * 256.0 + gs.g * 255.0) / 65535.0) * (sceneShade.uGroundRange.y - sceneShade.uGroundRange.x);

    // ---------- 像素高度(世界 → 直立 quad) ----------
    let pw = vWorld * sceneShade.uWorldToWork;
    let h = max((fw.y - pw.y) / max(sceneShade.uCosT * ppu, 1e-6), 0.0);
    let qx = (pw.x - sceneShade.uCal.z) / ppu;

    // ---------- 法线:与 color 同一个 vUV 采样,镜像只翻方向分量 ----------
    var ne = vec4<f32>(0.5, 0.5, 1.0, 0.35);
    if (entityShade.uHasNrm > 0.5) { ne = textureSampleLevel(uNrm, uNrmSampler, vUV, 0.0); }
    var n = normalize(vec3<f32>(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (vMirror > 0.5) { n.x = -n.x; }
    n = normalize(mix(n, vec3<f32>(0., 0., -1.), frameShade.uFlatten));

    let bulgeQ = frameShade.uBulge * entityShade.uBodyWidthWu / max(charLights.uSMWuPerQUnit, 1e-6);
    let q = vec3<f32>(qx, qyF + h * sceneShade.uCosT, footD - h * sceneShade.uSinT - ne.a * bulgeQ);

    // 法线档必须是**独占区间**:uShowN=2 是 skyao 档,写成 > 0.5 会被这条
    // 先接住并 return,于是「看 skyao」看到的是法线(2026-09-01 踩过)。
    if (frameShade.uShowN > 0.5 && frameShade.uShowN < 1.5) {
        return vec4<f32>((n * .5 + .5) * color.a, color.a) * vColor;
    }

    // ---------- 法线有两种用法，各自的空间都是定死的 ----------
    //
    // 上面那个 n 是**世界法线**，而且中性法线是**水平的**（制作人 2026-08-31
    // 点破的几何事实）：角色是一块直立 quad，直立面的面法线只能水平。法线图是
    // bake_normal_atlas.py 在图像像素空间取梯度（gx, -gy, -6），贴上直立 quad 后
    // 那三个轴恰好就是世界 X / Y / −Z —— 中性 (0,0,-1) = 水平朝相机。
    //
    // · **灯循环直接用 n**（世界对世界，铁律 0）——乘 R 等于把法线整体仰起 45°，
    //   头顶的灯过亮、水平来的灯偏暗（2026-08-30 踩过）。
    // · **probe / RT / 太阳查表用 nQ = R^T·n**：SH 载荷的方向基是 q 空间
    //   （pipeline.py _trace 明文 "dirs in q-space"，且逐轴各向异性缩放坐实），
    //   查表方向必须转到同一基。与场景侧 SceneLightingPass 的 GI 体视图同口径。
    //
    // ⚠ 2026-08-31 曾以"实验室查看器原样传"为由把这里改成 probeE(q, n)，当天
    //   被审计钉死为回归：同一个 probeE，场景侧转 R^T、角色侧不转，两种读法
    //   各取一半；实测把角色底光压暗 23%（55→43）。实验室 CHAR_FS 把图集法线
    //   当 q 用是**实验室侧的既有分歧**（inbox 立案，改实验室不改这里），
    //   不构成运行时改约定的依据。beta=4.2 是在 R^T 口径下标定的。
    var nQ = normalize(wrWorldToQ(charLights.uSMRow0, charLights.uSMRow1, charLights.uSMRow2, n));
    // 诊断·定法线(F2 GI体档的诊断组):双方强制同一查表方向后,人与场景的亮度差
    // 100% 是**位置**差——把方向变量归零,专查采样位置。只改 probe / RT 查表,不碰灯循环。
    // 定法线一律用 **q 空间常量**:1 = 朝相机 q(0,0,-1),2 = 世界向上 q(0,cosT,-sinT)。
    // 旧写法把 world(0,0,-1) 各自过自家矩阵 —— det=+1(角色)与 det=-1(场景)两个
    // 世界里是两个**相反**的方向,「定法线=朝相机」两侧各查各的,一亮一黑还以为
    // 是数据坏了(2026-09-01 复盘)。q 是两侧共用的约定,常量即构造性同值。
    if (frameShade.uFixedNQ > 0.5) {
        if (frameShade.uFixedNQ > 1.5) {
            nQ = normalize(vec3<f32>(0., sceneShade.uCosT, -sceneShade.uSinT));
        } else {
            nQ = vec3<f32>(0., 0., -1.);
        }
    }

    // ---------- E:RT gather 或 probe 图集(公共块) ----------
    // 间接 / 直接两路保留到着色末端,分别乘当前场景的 factor,再乘总 factor。
    var E: vec3<f32>;
    if (frameShade.uMode < 0.5) {
        var vv: ClcVol;
        vv.uVolN = sceneShade.uVolN;
        vv.uVolTiles = sceneShade.uVolTiles;
        vv.uQMin = sceneShade.uQMin;
        vv.uQMax = sceneShade.uQMax;
        var rt: ClcRt;
        rt.uSpp = frameShade.uSpp;
        rt.uMSteps = frameShade.uMSteps;
        rt.uMissMode = frameShade.uMissMode;
        rt.uNEE = frameShade.uNEE;
        rt.uStep = frameShade.uStep;
        rt.uLightCount = sceneShade.uLightCount;
        rt.uLightQ = sceneShade.uLightQ;
        rt.uLightE = sceneShade.uLightE;
        E = gatherRT(q + nQ * 0.02, nQ, fragPos.xy, pp, vv, &rt, uVolRad, uVolEmit);
    } else {
        E = probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid);
    }
    let EgiPure = E * frameShade.uGiStrength;   // 历史 GI 诊断尺;正常受光的三项 factor 在末端计算
    // ---- skyao:**乘在 GI 上**,与全白 blend(制作人 2026-09-01)----
    // 天穹遮蔽是几何项,只该衰减 GI 底光;太阳是独立解析直射,不吃它
    // (太阳自己的遮蔽将来要走 V_dir(w) 那条闭式,不是这个各向同性的 V)。
    E *= mix(1.0, skyaoAt(q, nQ, sk, uSkyaoTex), clamp(frameShade.uSkyaoBlend, 0.0, 1.0));
    // 调试档:uShowN==2 ⇒ 直接把 skyao 的 V 画成灰度(1 = 不遮蔽 0 = 全遮)。
    // 判「这一项到底生没生效」只能看它 —— 角色在 800x450 里只有几十像素,
    // 靠肉眼比两张截图分不出 3 倍的 GI 差异(2026-09-01 实测走过这个弯路)。
    if (frameShade.uShowN > 4.5) { return vec4<f32>(skyaoBand(q, nQ, sk, uSkyaoTex) * color.a, color.a); }
    if (frameShade.uShowN > 3.5) { return vec4<f32>(skyaoRaw(q, sk, uSkyaoTex) * color.a, color.a); }
    if (frameShade.uShowN > 2.5) { return vec4<f32>(skyaoBox(q, sk) * color.a, color.a); }
    if (frameShade.uShowN > 1.5) {
        // 同 eOnly 那课:必须过与场景同一条显示链,否则与 uDebug==11 对看时角色凭空
        // 暗一档、半透明边缘一圈黑边(2026-09-01)。3/4/5 取证子档刻意保持裸值(读数用)。
        let v = skyaoAt(q, nQ, sk, uSkyaoTex);
        let vd = clamp(lcDisplayTransform(vec3<f32>(v),
            charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
            charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor),
            vec3<f32>(0.0), vec3<f32>(1.0));
        return vec4<f32>(vd * color.a, color.a);
    }
    var directE = vec3<f32>(0.0);
    if (frameShade.uSunOn > 0.5) {
        // F2 的测试太阳(实验室没有这一项)。uSunDirQ 是 q 空间方向,与 nQ 同基。
        directE += frameShade.uSunColor * max(dot(nQ, frameShade.uSunDirQ), 0.0);
    }

    // ---------- 实体灯:加性叠在 probe 的 GI 底光之上 ----------
    //
    // 模型(2026-08-30 制作人定调):原画就是被 GI 照亮的结果,probe 是同一份 GI 给
    // 角色的版本;实体灯在这之上**直接加**。场景侧同源(见 SceneLightingPass),
    // 灯来自同一次 packLights ⇒「灯对角色和场景一视同仁」是构造性的,不是两处写得像。
    //
    // 着色在 M-world(q 经 det=+1 的 R 旋过去),不是裸 q —— 裸 q 的 Y 是屏幕上、
    // 不是世界上,灯的仰角与 1/r² 会全错(coordinate-spaces 铁律 4)。循环本体在
    // ENTITY_SCENE_LIGHTS_WGSL(粒子受光拼的是同一段)。
    //
    // 法线直接用 n:它**已经是世界法线**(中性 = 水平,见上面"法线有两种用法"段),
    // 灯位 / P 也在世界 wu —— 世界对世界,谁都不用转。
    //
    // ⚠ 这里曾留过一段相反的注释("n 是 q 空间的量、必须转到 M-world、正面的
    //   世界朝向是 (0,+0.707,−0.707)")—— 那是错的:把中性法线说成上仰 45° 意味着
    //   直立的人像躺着的地面一样迎接头顶光、又拒收水平来的灯光。直立 quad 的
    //   面法线是**水平**的(制作人 2026-08-31 点破),worldSpaceShading 测试锁的
    //   就是这一约定。那段错注释误导过一整轮排查(照它摆的"贴脸灯"全在法线
    //   背面),删除防再骗。几何推论:**低于人的灯照不亮躯干正面是错觉**——
    //   水平法线下只要灯在 quad 平面靠相机一侧,脚边的火同样照亮胸口。
    directE += entitySceneLightsE(q, n);
    // ---- 「GI体·纯E」调试(F2 循环 8/9 档):albedo≡1,输出 E×2^β ----
    // 与场景侧 uDebug==8 逐字同式(不走 /π、eChroma 与显示变换):这是校验 probe 体
    // 的尺子,不是美术视图 —— 两边同式,人与地面的 E 才能逐像素直接比。
    if (frameShade.uEOnly > 0.5) {
        // ---- 取证子档(2026-09-01 单点双管线对测,console 直设 eOnlyDebug=2/3/4) ----
        // 2 = raw probeE(线性直出,无 β 无显示链) 3 = probeGridT/PN 染色 4 = valid 角数/8
        // 5 = 脚点 q((q-uQMin)/(uQMax-uQMin),整 quad 同值,采哪都行) 6 = vFootWorld/uSceneWorld
        if (frameShade.uEOnly > 1.5 && frameShade.uEOnly < 2.5) {
            return vec4<f32>(probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 2.5 && frameShade.uEOnly < 3.5) {
            return vec4<f32>((probeGridT(q, pp) / sceneShade.uPN) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 4.5 && frameShade.uEOnly < 5.5) {
            let qF = vec3<f32>(qxF, qyF, footD);
            return vec4<f32>(clamp((qF - sceneShade.uQMin) / max(sceneShade.uQMax - sceneShade.uQMin, vec3<f32>(1e-5)),
                                   vec3<f32>(0.), vec3<f32>(1.)) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 5.5) {
            return vec4<f32>(vec3<f32>(clamp(vFootWorld / max(sceneShade.uSceneWorld, vec2<f32>(1e-5)),
                                             vec2<f32>(0.), vec2<f32>(1.)), 0.5) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 3.5) {
            let tv = probeGridT(q, pp);
            let b0v = vec3<i32>(tv);
            let pnv = vec3<i32>(sceneShade.uPN + .5);
            var cnt = 0.;
            for (var c = 0; c < 8; c++) {
                let off = vec3<i32>(c & 1, (c >> 1u) & 1, (c >> 2u) & 1);
                let pi = min(b0v + off, pnv - 1);
                let fl = pi.x * (pnv.y * pnv.z) + pi.y * pnv.z + pi.z;
                cnt += step(.002, textureLoad(uValid, probeTexel(fl, 1, 0, pp), 0).r);
            }
            return vec4<f32>(vec3<f32>(cnt / 8.) * color.a, color.a) * vColor;
        }
        // ⚠ 用**乘 skyao 之前**的 E:场景侧 uDebug==8 是纯 E,这边拿乘过 V 的 E 去比
        // 就是双重衰减 —— 白天开阔处 V≈0.9 看不出,夜里墙边直接把人压黑(2026-09-01)。
        var pe = EgiPure * frameShade.uBeta;
        // 诊断:角色也画 probe 棋盘(cell 奇偶与场景 uDebug==9 同一套 probeGridT)。
        // 判据:格边必须笔直穿过脚点、走动时与地面棋盘同帧翻转、竖向格高与邻墙一致。
        if (frameShade.uEChecker > 0.5) {
            let cc = vec3<i32>(probeGridT(q, pp));
            pe *= mix(0.45, 1.0, f32((cc.x + cc.y + cc.z) & 1));
        }
        // ⚠ 必须过与场景**同一条显示链**:场景的调试输出写进 RT 后仍要被 LitBackground
        //   做显示变换(EV / tonemap / sRGB 收尾),角色直出线性值会平白暗一大截——
        //   2026-09-01 实测这口"假位置差"就有 ~3×(sRGB)+ tonemap 的成分。
        let peDisp = clamp(lcDisplayTransform(pe,
            charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
            charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor),
            vec3<f32>(0.0), vec3<f32>(1.0));
        return vec4<f32>(peDisp * color.a, color.a) * vColor;
    }
    let alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    // ★ 与背景同一份显示变换(lcDisplayTransform 收尾自带 sRGB,所以不再 lin2srgb)。
    var outRgb = clamp(lcDisplayTransform(
        shadeEntityLinear(alb, E, directE, frameShade.uIndirectFactor, frameShade.uDirectFactor,
                          frameShade.uTotalFactor, frameShade.uEChroma),
        charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
        charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor),
        vec3<f32>(0.0), vec3<f32>(1.0));

    let vy = clamp(vLocal.y, 0.0, 1.0);
    let contact = frameShade.uAOContact * smoothstep(0.78, 1.0, vy);
    let form = frameShade.uAOForm * vy;
    outRgb *= clamp(1.0 - contact - form, 0.0, 1.0);

    return vec4<f32>(outRgb * color.a, color.a) * vColor;
}
`].join(`
`);var Bu=class{constructor(e){this.pos=new Float32Array(8),this.uv=new Float32Array(8),this.geometry=new Yt({positions:this.pos,uvs:this.uv,indices:new Uint32Array([0,1,2,0,2,3])}),this.geometry.addAttribute(`aLocal`,{buffer:new Float32Array([0,0,1,0,1,1,0,1]),format:`float32x2`}),this.posBuf=this.geometry.getAttribute(`aPosition`).buffer,this.uvBuf=this.geometry.getAttribute(`aUV`).buffer,this.mesh=new Zt({geometry:this.geometry,shader:e})}setWorldTransform(e,t,n,r,i,a,o,s,c){let l=Math.cos(c),u=Math.sin(c),d=l*o,f=u*o,p=-u*s,m=l*s,h=this.mesh.shader.resources.entityShade.uniforms;h.uL2W0[0]=d*n,h.uL2W0[1]=p*n,h.uL2W0[2]=e+i*n,h.uL2W1[0]=f*r,h.uL2W1[1]=m*r,h.uL2W1[2]=t+a*r,this.mesh.shader.resources.entityShade.uniforms.uBodyWidthWu=Math.abs(this.pos[2]-this.pos[0])*Math.hypot(d*n,f*r)}sync(e,t,n,r,i){let a=this.pos,o=-r*t,s=(1-r)*t,c=-i*n,l=(1-i)*n;a[0]=o,a[1]=c,a[2]=s,a[3]=c,a[4]=s,a[5]=l,a[6]=o,a[7]=l,this.posBuf.update();let u=this.uv,d=e.uvs;u[0]=d.x0,u[1]=d.y0,u[2]=d.x1,u[3]=d.y1,u[4]=d.x2,u[5]=d.y2,u[6]=d.x3,u[7]=d.y3,this.uvBuf.update()}destroy(){this.mesh.removeFromParent(),this.mesh.destroy()}};function Vu(e,t,n,r,i){if(n<=0||r<=0||i.x<=0||i.y<=0)return 1;let a=e/n,o=t/r,s=a/i.x,c=o/i.y;return Math.max(1,s,c)}var Hu=12;function Uu(e,t=1){if(e<=1)return 0;let n=Number.isFinite(t)&&t>0?t:1,r=e-1,i=.18*Math.sqrt(r)*n;return Math.min(Hu,i)}function Wu(e){return new on({strength:Math.max(0,e),quality:3})}function Gu(e){let t=Number(e);return Number.isFinite(t)?Math.min(1,Math.max(0,t)):.5}var Ku=.5,qu=.1;function Ju(e){let t=Number(e);return!Number.isFinite(t)||t<=0?1:Math.min(10,Math.max(qu,t))}var Yu=.5;function Xu(e){let t=Number(e?.footOffset);return!Number.isFinite(t)||t<=0?0:Math.min(Yu,t)}function Zu(e,t){let n=e.atlasFrames;if(!Array.isArray(n)||n.length===0||!Number.isFinite(t)||t<=0)return null;let r=0;for(let e of n){let t=e?.contentHeight;typeof t==`number`&&Number.isFinite(t)&&t>r&&(r=t)}return r<=0?null:Math.max(0,(t-r)/2)}var Qu=class{get facingDirection(){return this.facingX<0?`left`:`right`}getShadingFrameInfo(){if(!this.baseTexture||!this.animDef)return null;let e=this.baseTexture.source,t=e.width,n=e.height;if(!t||!n)return null;let r=this.sprite.texture.frame;return{source:e,sheetUrl:this.animDef.resolvedSheetUrl??null,cols:this.animDef.cols,rows:this.animDef.rows,rect:[r.x/t,r.y/n,r.width/t,r.height/n],flipX:this.facingX<0}}constructor(){this.x=0,this.y=0,this.baseTexture=null,this.animDef=null,this.frames=new Map,this.facingX=1,this.worldWidth=0,this.worldHeight=0,this.contentBottomPadPx=null,this.depthScaleFactor=1,this.trajRotRad=0,this.trajScaleX=1,this.trajScaleY=1,this.trajAlpha=1,this.trajOverlayActive=!1,this.currentState=``,this.currentFrames=[],this.currentFrameDef=null,this.footOffset=0,this.groundTrimmedFrames=new Map,this.bodyReferenceFrames=null,this.effectiveLoop=!1,this.frameIndex=0,this.frameTimer=0,this.playing=!1,this.onCompleteCallback=null,this.playbackSpeed=1,this.playbackReverse=!1,this.pendingThenState=null,this.logicalToClip=new Map,this.pixelDensityBlur=null,this.pixelDensityMatchActive=!1,this.pixelDensityBlurMounted=!1,this.socketSet=null,this.contactSlots=new Set,this.attachments=new Map,this.bodyBurnAlbedo=null,this.bodyBurnGlow=null,this.anchorX=.5,this.anchorY=1,this.litQuad=null,this.litShader=null,this.litProvider=null,this.litColorSrc=null,this.litParentX=0,this.litParentY=0,this.litParentSX=1,this.litParentSY=1,this.litParentRot=0,this.container=new Ye,this.sprite=new ut,this.sprite.anchor.set(this.anchorX,this.anchorY),this.container.addChild(this.sprite)}setSpriteAnchor(e,t){let n=Number.isFinite(e)?Math.min(1,Math.max(0,e)):.5,r=Number.isFinite(t)?Math.min(1,Math.max(0,t)):1;n===this.anchorX&&r===this.anchorY||(this.anchorX=n,this.anchorY=r,this.applyEffectiveAnchor(),this.applySpriteScale())}getSpriteAnchor(){return{x:this.anchorX,y:this.anchorY}}effectiveAnchorY(e=this.footOffset){return this.anchorY*(1-e)}applyEffectiveAnchor(){let e=this.effectiveAnchorY();(this.sprite.anchor.x!==this.anchorX||this.sprite.anchor.y!==e)&&this.sprite.anchor.set(this.anchorX,e)}getFootOffset(){return this.footOffset}getGroundContactOffset(){if(this.anchorX===.5&&this.anchorY===1)return{x:0,y:0};let e=this.getWorldSize();return{x:(.5-this.anchorX)*e.width*this.facingX,y:(1-this.anchorY)*(1-this.footOffset)*e.height}}loadFromDef(e,t,n){this.disposeFrameTextures(),this.setSockets(n??null),this.baseTexture=e,this.animDef=t,this.worldWidth=t.worldWidth,this.worldHeight=t.worldHeight;let r=t.cols,i=t.rows,a=typeof t.cellWidth==`number`&&t.cellWidth>0?t.cellWidth:e.width/r,o=typeof t.cellHeight==`number`&&t.cellHeight>0?t.cellHeight:e.height/i;for(let[n,i]of Object.entries(t.states)){let s=[];for(let n of i.frames){let i=n%r,c=Math.floor(n/r),l=t.atlasFrames?.[n],u=l&&l.width>0?l.width:a,d=l&&l.height>0?l.height:o,f=new E(i*a,c*o,u,d),p=new I({source:e.source,frame:f});s.push(p)}this.frames.set(n,s)}this.contentBottomPadPx=Zu(t,o),this.applySpriteScale(),this.refreshLitQuad()}disposeFrameTextures(){this.contentBottomPadPx=null,this.sprite.texture=I.EMPTY;for(let e of this.groundTrimmedFrames.values())e.destroy(!1);this.groundTrimmedFrames.clear(),this.bodyReferenceFrames=null,this.footOffset=0;for(let e of this.frames.values())for(let t of e)t.destroy(!1);this.frames.clear(),this.currentFrames=[],this.currentFrameDef=null,this.effectiveLoop=!1,this.frameIndex=0,this.frameTimer=0,this.playing=!1,this.onCompleteCallback=null,this.playbackSpeed=1,this.playbackReverse=!1,this.pendingThenState=null,this.currentState=``}destroy(){this.detachAllSockets(),this.socketSet=null,this.disableBakedShading(),this.clearPixelDensityBlur(),this.disposeFrameTextures(),this.baseTexture=null,this.animDef=null,this.logicalToClip.clear(),this.container.destroy({children:!0})}enableBakedShading(e){this.litProvider=e,this.refreshLitQuad();for(let e of this.attachments.values())this.refreshAttachmentLit(e);this.syncAttachments()}refreshBakedShading(){if(this.litProvider){this.litQuad&&=(this.litQuad.destroy(),null),this.litShader&&this.litProvider.release(this.litShader),this.litShader=null,this.litColorSrc=null,this.sprite.renderable=!0,this.refreshLitQuad();for(let e of this.attachments.values())this.disposeAttachmentLit(e),this.refreshAttachmentLit(e);this.syncAttachments()}}disableBakedShading(){for(let e of this.attachments.values())this.disposeAttachmentLit(e),e.view.renderable=!0;this.litQuad&&=(this.litQuad.destroy(),null),this.litShader&&this.litProvider&&this.litProvider.release(this.litShader),this.litShader=null,this.litColorSrc=null,this.litProvider=null,this.sprite.renderable=!0}refreshLitQuad(){let e=this.litProvider;if(!e||!this.baseTexture||!this.animDef)return;let t=this.bodyBurnAlbedo?.source??this.baseTexture.source;if(this.litShader)this.litColorSrc!==t&&(e.swapTextures(this.litShader,t,this.animDef.resolvedSheetUrl??null),this.litColorSrc=t);else{let n=e.create(t,this.animDef.resolvedSheetUrl??null);if(!n)return;this.litShader=n,this.litColorSrc=t,this.litQuad=new Bu(n),this.container.addChild(this.litQuad.mesh),this.reorderAttachments(),this.placeBodyBurnGlow(),this.sprite.renderable=!1}this.syncLitQuad()}syncLitQuad(){if(!this.litQuad)return;let{frameW:e,frameH:t}=this.getCurrentFramePixelSize();this.litQuad.sync(this.sprite.texture,e,t,this.sprite.anchor.x,this.sprite.anchor.y);let n=this.litQuad.mesh;n.position.set(this.sprite.x,this.sprite.y),n.scale.set(this.sprite.scale.x,this.sprite.scale.y),n.rotation=this.sprite.rotation,this.syncLitQuadWorld()}setLitParentTransform(e,t,n,r,i){let a=n<0!=this.litParentSX<0;this.litParentX=e,this.litParentY=t,this.litParentSX=n,this.litParentSY=r,this.litParentRot=i,this.syncLitQuadWorld(),a&&this.syncAttachments()}hostMirrorX(){return this.litParentSX<0?-1:1}syncLitQuadWorld(){if(!this.litQuad)return;let e=this.litParentRot,t=Math.cos(e),n=Math.sin(e),r=this.litParentX+this.litParentSX*(t*this.container.x-n*this.container.y),i=this.litParentY+this.litParentSY*(n*this.container.x+t*this.container.y);this.litQuad.setWorldTransform(r,i,this.litParentSX*this.container.scale.x,this.litParentSY*this.container.scale.y,this.sprite.x,this.sprite.y,this.sprite.scale.x,this.sprite.scale.y,e+this.sprite.rotation)}setLogicalStateMap(e){if(this.logicalToClip.clear(),this.bodyReferenceFrames=null,e)for(let[t,n]of Object.entries(e))t&&n&&this.logicalToClip.set(t,n)}resolveClip(e){return this.logicalToClip.get(e)??e}resolveLogicalClip(e){return this.resolveClip(e)}getCurrentClipDurationSec(){let e=this.currentFrames.length;if(e<=0||!this.currentFrameDef)return 0;let t=Number(this.currentFrameDef.frameRate);return e/((Number.isFinite(t)&&t>0?t:8)*(this.playbackSpeed>0?this.playbackSpeed:1))}hasLogicalState(e){let t=e.trim();if(!t)return!1;let n=this.resolveClip(t);if(!this.animDef?.states?.[n])return!1;let r=this.frames.get(n);return!!r&&r.length>0}playAnimation(e,t,n){let r=this.resolveClip(e);if(!n&&this.currentState===r&&this.playing)return;let i=this.animDef?.states[r],a=this.frames.get(r);if(!i||!a||a.length===0)return;this.currentState=r,this.currentFrames=a,this.currentFrameDef=i,this.footOffset=Xu(i),this.effectiveLoop=n?.loop??i.loop,this.frameTimer=0,this.onCompleteCallback=t??null,this.playbackSpeed=n?.speed===void 0?1:Ju(n.speed),this.playbackReverse=n?.reverse===!0,this.pendingThenState=n?.thenState?.trim()||null;let o=n?.holdFrame,s=n?.startFrame;if(typeof o==`number`&&Number.isFinite(o)){let e=a.length;this.frameIndex=(Math.trunc(o)%e+e)%e,this.playing=!1,this.pendingThenState=null}else if(typeof s==`number`&&Number.isFinite(s)){let e=a.length;this.frameIndex=(Math.trunc(s)%e+e)%e,this.playing=!0}else this.frameIndex=this.playbackReverse?a.length-1:0,this.playing=!0;this.showFrameTexture(a[this.frameIndex]),this.applySpriteScale()}setDirection(e,t){e>0?this.facingX=1:e<0&&(this.facingX=-1),this.applySpriteScale()}update(e){if(!this.playing||!this.currentFrameDef||this.currentFrames.length<=1){this.syncPosition();return}this.frameTimer+=e;let t=Number(this.currentFrameDef.frameRate),n=1/((Number.isFinite(t)&&t>0?t:8)*this.playbackSpeed);for(;this.frameTimer>=n;)if(this.frameTimer-=n,this.frameIndex+=this.playbackReverse?-1:1,this.frameIndex<0||this.frameIndex>=this.currentFrames.length)if(this.effectiveLoop)this.frameIndex=this.playbackReverse?this.currentFrames.length-1:0;else{this.frameIndex=this.playbackReverse?0:this.currentFrames.length-1,this.playing=!1,this.onCompleteCallback?.();let e=this.pendingThenState;this.pendingThenState=null,e&&this.playAnimation(e);break}this.showFrameTexture(this.currentFrames[this.frameIndex]),this.applySpriteScale(),this.syncPosition()}syncPosition(){this.container.x=this.x,this.container.y=this.y,this.syncLitQuadWorld()}getCurrentState(){return this.currentState}getFrameCount(){return this.currentFrames.length}getFrameIndex(){return this.frameIndex}getDebugVisualState(){let e=this.sprite.texture?.frame;return{state:this.currentState,frameIndex:this.frameIndex,frameTimer:this.frameTimer,playing:this.playing,visualLiftY:this.sprite.y,facing:this.facingDirection,worldWidth:this.worldWidth,worldHeight:this.worldHeight,depthScaleFactor:this.depthScaleFactor,trajectoryOverlay:this.getTrajectoryOverlay(),frame:e?{x:e.x,y:e.y,width:e.width,height:e.height}:null,pixelDensityMatchActive:this.pixelDensityMatchActive,footOffset:this.footOffset,spriteAnchor:{x:this.sprite.anchor.x,y:this.sprite.anchor.y}}}applyLocomotionSpeed(e){let t=Number(this.currentFrameDef?.referenceSpeed);if(!Number.isFinite(t)||t<=0||!Number.isFinite(e)||e<=0){this.playbackSpeed=1;return}this.playbackSpeed=Math.min(2,Math.max(Ku,e/t))}resetAnimationClock(){this.frameIndex=this.playbackReverse?Math.max(0,this.currentFrames.length-1):0,this.frameTimer=0,this.currentFrames.length>0&&(this.showFrameTexture(this.currentFrames[this.frameIndex]),this.applySpriteScale())}setFrameIndex(e){if(this.currentFrames.length===0)return;let t=this.currentFrames.length,n=(Math.trunc(e)%t+t)%t;this.frameIndex=n,this.frameTimer=0,this.showFrameTexture(this.currentFrames[n]),this.applySpriteScale(),this.syncPosition()}setVisualLiftY(e){this.sprite.y=Number.isFinite(e)?e:0,this.syncLitQuad(),this.syncAttachments()}setTrajectoryOverlay(e,t,n,r,i=1){this.trajRotRad=(Number.isFinite(e)?e:0)*(i<0?-1:1),this.trajScaleX=Number.isFinite(t)?t:1,this.trajScaleY=Number.isFinite(n)?n:1,this.trajAlpha=Number.isFinite(r)?Math.min(1,Math.max(0,r)):1,this.trajOverlayActive=!0,this.sprite.rotation=this.trajRotRad,this.container.alpha=this.trajAlpha,this.applySpriteScale()}clearTrajectoryOverlay(){this.trajOverlayActive&&(this.trajRotRad=0,this.trajScaleX=1,this.trajScaleY=1,this.trajAlpha=1,this.trajOverlayActive=!1,this.sprite.rotation=0,this.container.alpha=1,this.applySpriteScale())}getTrajectoryOverlay(){return{active:this.trajOverlayActive,rotRad:this.trajRotRad,scaleX:this.trajScaleX,scaleY:this.trajScaleY,alpha:this.trajAlpha}}syncPositionNow(){this.syncPosition()}setPlaying(e){e&&!this.playing&&this.currentFrames.length>0&&(this.effectiveLoop||(this.playbackReverse?this.frameIndex<=0:this.frameIndex>=this.currentFrames.length-1)&&(this.frameIndex=this.playbackReverse?this.currentFrames.length-1:0)),this.playing=e&&this.currentFrames.length>0}getStateNames(){return this.animDef?Object.keys(this.animDef.states):[]}getSpriteWorldBounds(){if(!this.sprite)return null;let e=this.sprite.getBounds();return{x:e.x,y:e.y,width:e.width,height:e.height}}getWorldSize(){return{width:this.worldWidth*this.depthScaleFactor,height:this.worldHeight*this.depthScaleFactor}}getContentBoxLocal(){let e=this.contentBottomPadPx;if(e===null||!this.animDef)return null;let t=this.currentFrameContentBoxPx();if(!t)return null;let{frameW:n,frameH:r}=this.getCurrentFramePixelSize();if(!(n>0)||!(r>0))return null;let i=this.worldWidth*this.depthScaleFactor/n,a=this.worldHeight*this.depthScaleFactor/r;return{width:t.w*i,height:t.h*a,bottomGap:Math.max(e,this.footOffset*r)*a-this.sprite.y-(1-this.sprite.anchor.y)*this.worldHeight*this.depthScaleFactor}}setSockets(e){e?.stale&&console.warn(`SpriteEntity: sockets.json 与当前图集指纹不符（重导出过？），本包挂点全部忽略——请回编辑器重标`),this.socketSet=e&&!e.stale?e.set:null,this.contactSlots=new Set(this.socketSet?.contactSlots??[]);for(let e of this.attachments.values())e.view.visible=!1}isContactFrameAt(e){if(this.contactSlots.size===0)return!1;let t=this.currentFrameDef?.frames;if(!t||t.length===0)return!1;let n=t[(e%t.length+t.length)%t.length];return n!==void 0&&this.contactSlots.has(n)}listSocketNames(){return this.socketSet?Object.keys(this.socketSet.sockets):[]}debugSocketSet(){return this.socketSet}debugCurrentAtlasSlot(){return this.currentAtlasSlot()}debugAtlasSlotCount(){return this.animDef?.atlasFrames?.length??0}debugAtlasFingerprint(){return this.animDef?xu(this.animDef):{cols:0,rows:0,slotCount:0}}currentAtlasSlot(){let e=this.currentFrameDef?.frames;return!e||e.length===0?null:e[this.frameIndex%e.length]??null}getSocketPoseRaw(e){let t=this.socketSet?.sockets[e];if(!t)return null;let n=this.currentAtlasSlot();return n===null?null:t.poses[String(n)]??null}getSocketPose(e){let t=this.getSocketPoseRaw(e);return t?Cu(t,{worldWidth:this.worldWidth,worldHeight:this.worldHeight,depthScale:this.depthScaleFactor,facing:this.facingX,hostMirrorX:this.hostMirrorX(),visualLiftY:this.sprite.y,anchorX:this.anchorX,anchorY:this.effectiveAnchorY()}):null}getSocketOffsetFromContact(e){let t=this.getSocketPose(e);return t?this.offsetFromContactOfLocal(t.x,t.y,t.front):null}getAttachmentPointOffsetFromContact(e,t,n){let r=this.attachments.get(e);if(!r)return null;let i=this.getSocketPose(e);if(!i)return null;let a=this.attachmentLocalPoint(r,this.attachmentTransform(r,i),t,n);return a?this.offsetFromContactOfLocal(a.x,a.y,i.front):null}predictAttachmentPointOffset(e,t,n,r){let i=this.attachments.get(e);if(!i)return null;let a=this.slotOfLogicalFrame(r.logicalState,r.frameIndex);if(a===null)return null;let o=this.socketSet?.sockets[e]?.poses[String(a)];if(!o)return null;let s=r.depthScale>0&&Number.isFinite(r.depthScale)?r.depthScale:1,c=Xu(this.animDef?.states?.[this.resolveClip(r.logicalState)]),l=Cu(o,{worldWidth:this.worldWidth,worldHeight:this.worldHeight,depthScale:s,facing:r.facing,hostMirrorX:this.hostMirrorX(),visualLiftY:0,anchorX:this.anchorX,anchorY:this.effectiveAnchorY(c)}),u=i.view.texture,d=u?.frame?.width??0,f=u?.frame?.height??0;if(!(d>0)||!(f>0))return null;let p=Tu(l,{scale:i.scale,anchorX:i.anchorX,anchorY:i.anchorY,rotationOffsetDeg:i.rotationOffsetDeg,mirrorWithHost:i.mirrorWithHost,texW:d,texH:f},t,n),m=(.5-this.anchorX)*this.worldWidth*s*r.facing,h=(1-this.anchorY)*(1-c)*this.worldHeight*s,g=(p.x-m)*this.litParentSX,_=(p.y-h)*this.litParentSY,v=this.litParentRot;if(v===0)return{x:g,y:_};let y=Math.cos(v),b=Math.sin(v);return{x:g*y-_*b,y:g*b+_*y}}slotOfLogicalFrame(e,t){let n=this.animDef?.states?.[this.resolveClip(e)]?.frames;if(!n||n.length===0)return null;let r=n.length;return n[(Math.trunc(t)%r+r)%r]??null}igniteContactFrame(e){let t=this.animDef?.states?.[this.resolveClip(e)]?.frames;if(!t||t.length===0)return null;let n=this.socketSet?.igniteSlots??[];if(n.length>0){let e=new Set(n);for(let n=0;n<t.length;n++)if(e.has(t[n]))return{frame:n,marked:!0,frameCount:t.length}}return{frame:0,marked:!1,frameCount:t.length}}offsetFromContactOfLocal(e,t,n){let r=this.getGroundContactOffset(),i=(e-r.x)*this.litParentSX,a=(t-r.y)*this.litParentSY,o=this.litParentRot+this.sprite.rotation,s=this.getWorldSize().width*Math.abs(this.trajScaleX)*Math.hypot(Math.cos(o)*this.litParentSX*this.container.scale.x,Math.sin(o)*this.litParentSY*this.container.scale.y),c=s*.06,l=this.litParentRot;if(l===0)return{x:i,y:a,front:n,clearanceWu:c,bodyWidthWu:s};let u=Math.cos(l),d=Math.sin(l);return{x:i*u-a*d,y:i*d+a*u,front:n,clearanceWu:c,bodyWidthWu:s}}attachToSocket(e,t){this.detachFromSocket(e),this.attachments.set(e,t),this.container.addChild(t.view),t.flame&&(t.flame.view.visible=!1,this.container.addChild(t.flame.view)),this.refreshAttachmentLit(t),this.syncAttachments()}setAttachmentFlame(e,t){let n=this.attachments.get(e);if(!n?.flame)return;n.flame.params=t;let r=this.getSocketPose(e);if(!r){n.flame.view.visible=!1;return}this.syncAttachmentFlame(n,this.attachmentTransform(n,r),r.scale)}refreshAttachmentLit(e){let t=e.lit!==!1&&this.litProvider!==null,n=e.view.texture;if(!t||!n?.source){this.disposeAttachmentLit(e),e.view.renderable=!0;return}if(e.litQuad&&e.litSrc===n.source)return;this.disposeAttachmentLit(e);let r=this.litProvider.create(n.source,null);if(!r){e.view.renderable=!0;return}e.litShader=r,e.litSrc=n.source,e.litQuad=new Bu(r),this.container.addChild(e.litQuad.mesh),e.view.renderable=!1,this.reorderAttachments()}disposeAttachmentLit(e){e.litQuad&&=(e.litQuad.destroy(),null),e.litShader&&this.litProvider&&this.litProvider.release(e.litShader),e.litShader=null,e.litSrc=null}detachFromSocket(e){let t=this.attachments.get(e);t&&(this.attachments.delete(e),this.disposeAttachmentLit(t),t.view.renderable=!0,t.view.parent===this.container&&this.container.removeChild(t.view),t.flame&&t.flame.view.parent===this.container&&this.container.removeChild(t.flame.view),t.burnGlow&&=(t.burnGlow.removeFromParent(),t.burnGlow.destroy({texture:!1}),null),t.burnBase&&=(t.view.texture=t.burnBase,null))}detachAllSockets(){for(let e of[...this.attachments.keys()])this.detachFromSocket(e)}listAttachedSockets(){return[...this.attachments.keys()]}syncAttachments(){if(this.attachments.size===0)return;let e=!1;for(let[t,n]of this.attachments){let r=this.getSocketPose(t);if(!r){n.view.visible=!1,n.litQuad&&(n.litQuad.mesh.visible=!1),n.flame&&(n.flame.view.visible=!1),n.burnGlow&&(n.burnGlow.visible=!1);continue}n.view.visible=!0;let i=Gu(n.anchorX??.5),a=Gu(n.anchorY??.5),o=n.view;o.anchor&&(o.anchor.x!==i||o.anchor.y!==a)&&o.anchor.set(i,a);let s=this.attachmentTransform(n,r);if(n.view.x=s.x,n.view.y=s.y,n.view.scale.set(s.sx,s.sy),n.view.rotation=s.rot,n.frameTextures&&n.frameTextures.length>0&&r.frame!==null){let e=n.frameTextures.length,t=(r.frame%e+e)%e,i=n.frameTextures[t],a=n.view;i&&a.texture!==i&&(a.texture=i)}if(this.refreshAttachmentLit(n),this.syncAttachmentLit(n),n.burnGlow){let e=n.burnGlow;e.anchor.set(o.anchor.x,o.anchor.y),e.position.set(n.view.x,n.view.y),e.scale.set(n.view.scale.x,n.view.scale.y),e.rotation=n.view.rotation,e.visible=!0}n.flame&&this.syncAttachmentFlame(n,s,r.scale),n.lastFront!==r.front&&(n.lastFront=r.front,e=!0)}e&&this.reorderAttachments()}attachmentTransform(e,t){let n=e.scale??1,r=e.mirrorWithHost===!1?1:t.facing,i=(e.rotationOffsetDeg??0)*t.facing,a=t.x,o=t.y,s=n*t.scale*r,c=n*t.scale,l=(t.angleDeg+i)*Math.PI/180;if(this.trajOverlayActive){let e=a*this.trajScaleX,t=o*this.trajScaleY,n=Math.cos(this.trajRotRad),r=Math.sin(this.trajRotRad);a=e*n-t*r,o=e*r+t*n,s*=this.trajScaleX,c*=this.trajScaleY,l+=this.trajRotRad}return{x:a,y:o,sx:s,sy:c,rot:l}}attachmentLocalPoint(e,t,n,r){let i=e.view.texture,a=i?.frame?.width??0,o=i?.frame?.height??0;if(!(a>0)||!(o>0))return null;let s=(Gu(n)-Gu(e.anchorX??.5))*a*t.sx,c=(Gu(r)-Gu(e.anchorY??.5))*o*t.sy,l=Math.cos(t.rot),u=Math.sin(t.rot);return{x:t.x+s*l-c*u,y:t.y+s*u+c*l}}syncAttachmentFlame(e,t,n){let r=e.flame;if(!r)return;let i=r.params,a=r.frames,o=r.view;if(!i||!i.visible||a.length===0||!e.view.visible){o.visible=!1;return}let s=e.firePoint?this.attachmentLocalPoint(e,t,e.firePoint[0],e.firePoint[1]):{x:t.x,y:t.y},c=a.length,l=a[(Math.trunc(i.frame)%c+c)%c],u=l.frame.height;if(!s||!(u>0)||!(i.heightWu>0)){o.visible=!1;return}o.texture!==l&&(o.texture=l);let d=i.heightWu*n*Math.abs(this.trajScaleY)/u;o.scale.set(d,d),o.position.set(s.x,s.y),o.rotation=(this.litParentSX<0?-1:1)*(i.angleRad-this.litParentRot),o.visible=!0}syncAttachmentLit(e){let t=e.litQuad;if(!t)return;let n=e.view,r=n.texture;if(!r)return;t.sync(r,r.frame.width,r.frame.height,n.anchor.x,n.anchor.y);let i=t.mesh;i.visible=n.visible,i.position.set(n.x,n.y),i.scale.set(n.scale.x,n.scale.y),i.rotation=n.rotation;let a=this.litParentRot,o=Math.cos(a),s=Math.sin(a),c=this.litParentX+this.litParentSX*(o*this.container.x-s*this.container.y),l=this.litParentY+this.litParentSY*(s*this.container.x+o*this.container.y);t.setWorldTransform(c,l,this.litParentSX*this.container.scale.x,this.litParentSY*this.container.scale.y,n.x,n.y,n.scale.x,n.scale.y,n.rotation+a)}reorderAttachments(){for(let e of this.attachments.values()){let t=[e.view,e.litQuad?.mesh,e.burnGlow,e.flame?.view],n=e.lastFront||!e.flame?t:[...t].reverse();for(let t of n)!t||t.parent!==this.container||(e.lastFront?this.container.setChildIndex(t,this.container.children.length-1):this.container.setChildIndex(t,0))}}getAuthoredBubbleAnchorLocalY(){let e=this.currentFrameDef?.bubbleAnchor;if(typeof e!=`number`||!Number.isFinite(e)||e<=0)return null;let t=this.worldHeight*this.depthScaleFactor;return this.sprite.y+(1-this.sprite.anchor.y)*t-e*t}currentFrameContentBoxPx(){let e=this.animDef?.atlasFrames,t=this.currentFrameDef?.frames;if(!e||e.length===0||!t||t.length===0)return null;let n=e[t[this.frameIndex%t.length]],r=n?.contentWidth,i=n?.contentHeight;return typeof r!=`number`||!Number.isFinite(r)||r<=0||typeof i!=`number`||!Number.isFinite(i)||i<=0?null:{w:r,h:i}}setDepthScaleFactor(e){let t=Number.isFinite(e)&&e>0?e:1;t!==this.depthScaleFactor&&(this.depthScaleFactor=t,this.applySpriteScale())}getDepthScaleFactor(){return this.depthScaleFactor}getDisplayTexture(){let e=this.sprite.texture;if(!e||e===I.EMPTY)return null;if(this.footOffset<=0)return e;let t=this.currentFrames[this.frameIndex];return!t||e!==t?e:this.groundTrimmedFrame(t)}getBodyReferenceFrames(){if(this.bodyReferenceFrames)return this.bodyReferenceFrames;let e=this.animDef?.states;if(!e)return[];let t=this.resolveClip(`idle`);this.frames.get(t)?.length||(t=Object.keys(e).find(e=>(this.frames.get(e)?.length??0)>0)??``);let n=this.frames.get(t);if(!n?.length)return[];let r=Xu(e[t]);return this.bodyReferenceFrames=r>0?n.map(e=>this.groundTrimmedFrame(e,r)):n.slice(),this.bodyReferenceFrames}groundTrimmedFrame(e,t=this.footOffset){let n=this.groundTrimmedFrames.get(e);if(n)return n;let r=e.frame,i=r.height*(1-t);if(!(i>=1))return e;let a=new I({source:e.source,frame:new E(r.x,r.y,r.width,i)});return this.groundTrimmedFrames.set(e,a),a}setPixelDensityMatchActive(e){this.pixelDensityMatchActive!==e&&(this.pixelDensityMatchActive=e,this.sprite.roundPixels=e,e||this.clearPixelDensityBlur())}getPixelDensityMatchActive(){return this.pixelDensityMatchActive}applyPixelDensityMatch(e,t=1){if(!this.pixelDensityMatchActive)return;if(!e||!this.baseTexture||!this.animDef){this.clearPixelDensityBlur();return}let{frameW:n,frameH:r}=this.getCurrentFramePixelSize(),i=Uu(Vu(n,r,this.worldWidth*this.depthScaleFactor,this.worldHeight*this.depthScaleFactor,e),t);if(i<=0){this.unmountPixelDensityBlur();return}this.pixelDensityBlur?this.pixelDensityBlur.strength=i:this.pixelDensityBlur=Wu(i),this.pixelDensityBlurMounted||=(this.sprite.filters=[this.pixelDensityBlur],!0)}unmountPixelDensityBlur(){this.pixelDensityBlurMounted&&=(this.sprite.filters=[],!1)}clearPixelDensityBlur(){this.unmountPixelDensityBlur(),this.pixelDensityBlur&&=(this.pixelDensityBlur.destroy(),null)}getCurrentFramePixelSize(){let e=this.baseTexture,t=this.animDef;if(!e||!t)return{frameW:1,frameH:1};let n=typeof t.cellWidth==`number`&&t.cellWidth>0?t.cellWidth:e.width/t.cols,r=typeof t.cellHeight==`number`&&t.cellHeight>0?t.cellHeight:e.height/t.rows,i=n,a=r;if(this.currentFrameDef&&t.atlasFrames&&t.atlasFrames.length>0){let e=this.currentFrameDef.frames,n=e[this.frameIndex%e.length],r=t.atlasFrames[n];r&&r.width>0&&r.height>0&&(i=r.width,a=r.height)}return{frameW:i,frameH:a}}applySpriteScale(){this.applyEffectiveAnchor();let e=this.baseTexture,t=this.animDef;if(!e||!t){this.sprite.scale.set(this.facingX*this.trajScaleX,this.trajScaleY);return}let{frameW:n,frameH:r}=this.getCurrentFramePixelSize();this.sprite.scale.set(this.worldWidth*this.depthScaleFactor/n*this.facingX*this.trajScaleX,this.worldHeight*this.depthScaleFactor/r*this.trajScaleY),this.syncLitQuad(),this.syncBodyBurnGlow(),this.syncAttachments()}showFrameTexture(e){this.sprite.texture=this.bodyBurnAlbedo&&!this.litQuad?this.bodyBurnAlbedo:e}bodyBurnBaseTexture(){return this.currentFrames[this.frameIndex]??null}setBodyBurnTextures(e,t){if(this.bodyBurnAlbedo=e,this.litShader&&this.litProvider&&this.baseTexture&&this.animDef){let t=e?.source??this.baseTexture.source;this.litColorSrc!==t&&(this.litProvider.swapTextures(this.litShader,t,this.animDef.resolvedSheetUrl??null),this.litColorSrc=t)}let n=this.currentFrames[this.frameIndex];n&&this.showFrameTexture(n),t?this.bodyBurnGlow?this.bodyBurnGlow.texture!==t&&(this.bodyBurnGlow.texture=t):(this.bodyBurnGlow=new ut(t),this.bodyBurnGlow.blendMode=`add`,this.container.addChild(this.bodyBurnGlow),this.placeBodyBurnGlow()):this.bodyBurnGlow&&=(this.bodyBurnGlow.removeFromParent(),this.bodyBurnGlow.destroy({texture:!1}),null),this.syncBodyBurnGlow()}placeBodyBurnGlow(){let e=this.bodyBurnGlow;if(!e||e.parent!==this.container)return;let t=this.litQuad?.mesh.parent===this.container?this.litQuad.mesh:this.sprite;if(t.parent!==this.container)return;let n=this.container.getChildIndex(t),r=this.container.getChildIndex(e);this.container.setChildIndex(e,r<n?n:Math.min(this.container.children.length-1,n+1))}syncBodyBurnGlow(){let e=this.bodyBurnGlow;e&&(e.anchor.set(this.sprite.anchor.x,this.sprite.anchor.y),e.position.set(this.sprite.x,this.sprite.y),e.scale.set(this.sprite.scale.x,this.sprite.scale.y),e.rotation=this.sprite.rotation,e.visible=this.sprite.visible)}bodyUvToLayer(e,t,n){let r=this.sprite.texture,i=r?.frame?.width??0,a=r?.frame?.height??0;if(!(i>0)||!(a>0)||this.currentFrames.length===0)return null;let o=this.sprite.toGlobal({x:(t-this.sprite.anchor.x)*i,y:(n-this.sprite.anchor.y)*a});return e.toLocal(o)}attachmentUvToLayer(e,t,n,r){let i=this.attachments.get(e);if(!i||!i.view.visible||!this.getSocketPose(e))return null;let a=i.view,o=a.texture?.frame?.width??0,s=a.texture?.frame?.height??0;if(!(o>0)||!(s>0))return null;let c=a.toGlobal({x:(n-a.anchor.x)*o,y:(r-a.anchor.y)*s});return t.toLocal(c)}attachmentBurnBaseTexture(e){let t=this.attachments.get(e);return t?t.burnBase??t.view.texture??null:null}setAttachmentBurnTextures(e,t,n){let r=this.attachments.get(e);if(!r)return;let i=r.view;t?(r.burnBase||=i.texture,i.texture!==t&&(i.texture=t)):r.burnBase&&=(i.texture=r.burnBase,null),n?r.burnGlow?r.burnGlow.texture!==n&&(r.burnGlow.texture=n):(r.burnGlow=new ut(n),r.burnGlow.blendMode=`add`,this.container.addChild(r.burnGlow),this.reorderAttachments()):r.burnGlow&&=(r.burnGlow.removeFromParent(),r.burnGlow.destroy({texture:!1}),null),this.syncAttachments()}},$u=100;function ed(e,t,n){let r=Math.max(1,e.cols),i=Math.max(1,e.rows),a,o;return a=typeof e.cellWidth==`number`&&e.cellWidth>0?e.cellWidth:t/r,o=typeof e.cellHeight==`number`&&e.cellHeight>0?e.cellHeight:n/i,{cellW:a,cellH:o}}function td(e,t,n){let{cellW:r,cellH:i}=ed(e,t,n),a=i/r,o=e.worldWidth,s=e.worldHeight,c=typeof o==`number`&&o>0?o:void 0,l=typeof s==`number`&&s>0?s:void 0;if(c!==void 0&&l!==void 0)return{worldWidth:c,worldHeight:l};if(c!==void 0)return{worldWidth:c,worldHeight:Math.round(c*a*1e6)/1e6};if(l!==void 0)return{worldWidth:Math.round(l/a*1e6)/1e6,worldHeight:l};let u=$u;return{worldWidth:u,worldHeight:Math.round(u*a*1e6)/1e6}}function nd(e,t,n,r){let{cellW:i,cellH:a}=ed(e,t,n),{worldWidth:o,worldHeight:s}=td(e,t,n);return{...e,resolvedSheetUrl:r,worldWidth:o,worldHeight:s,cellWidth:Math.round(i*1e6)/1e6,cellHeight:Math.round(a*1e6)/1e6}}var rd=`
struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
};

struct LightUniforms {
    uSceneSize: vec2<f32>,
    uProjectionScale: f32,
    uWorldToPixelX: f32,
    uWorldToPixelY: f32,
    uWorldContainerPos: vec2<f32>,
    uEntityFootWorldX: f32,
    uEntityFootWorldY: f32,
    uSampleLiftWorld: f32,
    uDepthEnabled: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uDepthPerSy: f32,
    uFloorOffset: f32,
    uFloorOffsetExtra: f32,
    uTolerance: f32,
    uOcclusionBlendFactor: f32,
    uDebug: f32,
    uFootDepthQ: f32,
    uHasFootDepth: f32,
    uFootBias: f32,
    uHasFgCoverage: f32,
    uKeyColor: vec3<f32>,
    uKeyIntensity: f32,
    uAmbientColor: vec3<f32>,
    uAmbientIntensity: f32,
    uToneStrength: f32,
    uAOContact: f32,
    uAOForm: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> lightUniforms: LightUniforms;
@group(1) @binding(1) var uDepthMap: texture_2d<f32>;
@group(1) @binding(2) var uDepthMapSampler: sampler;
@group(1) @binding(3) var uProbe: texture_2d<f32>;
@group(1) @binding(4) var uProbeSampler: sampler;
${Mu(1,5)}
${ju}

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
    var out: VSOutput;
    out.position = filterVertexPosition(aPosition);
    out.vTextureCoord = filterTextureCoord(aPosition);
    out.vScreenPos = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    return out;
}

fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

@fragment
fn mainFragment(
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let u = lightUniforms;
    let color = textureSample(uTexture, uSampler, vTextureCoord);
    if (color.a < 0.004) { discard; }

    let S = max(u.uProjectionScale, 1e-6);
    let wx = (vScreenPos.x - u.uWorldContainerPos.x) / S;
    let wy = (vScreenPos.y - u.uWorldContainerPos.y) / S;

    var occluded = false;
    // 深度遮挡(需深度图 + 行走面脚点深度;缺一不做,绝不退回旧模型)
    if (u.uDepthEnabled > 0.5 && u.uHasFootDepth > 0.5) {
        let depthUV = vec2<f32>(wx / u.uSceneSize.x, wy / u.uSceneSize.y);
        if (depthUV.x >= 0.0 && depthUV.x <= 1.0 && depthUV.y >= 0.0 && depthUV.y <= 1.0) {
            let depthSample = textureSampleLevel(uDepthMap, uDepthMapSampler, depthUV, 0.0);
            let rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
            var d_raw = rawDepth;
            if (u.uInvert > 0.5) { d_raw = 1.0 - rawDepth; }
            let sceneDepth = d_raw * u.uScale + u.uOffset;
            // 精灵深度代理:立在伪世界里的直立 quad(uDepthPerSy = tanθ/ppu 是它的深度梯度,往上越靠近相机)。
            // 脚点深度取行走面场实测值——floor 拟合直线在多层街巷可偏出 200+ 行地面,已废除,无场时干脆不遮挡(见 uHasFootDepth)
            let syTexFoot = u.uEntityFootWorldY * u.uWorldToPixelY;
            let syTex = wy * u.uWorldToPixelY;
            let upright = u.uDepthPerSy * (syTex - syTexFoot);
            let spriteDepth = u.uFootDepthQ + upright + u.uFloorOffset + u.uFloorOffsetExtra - u.uFootBias;
            // 场景前景层(三份遮挡实现同一段,见 foregroundMaskWgsl):前景面按接地深度立起来的直立面比,
            // 不加脚点偏置 / 容差 / floor 偏移;外沿(深度图糊的那圈)不判
            var fgDepth: f32;
            let fgKind = fgSample(depthUV, u.uHasFgCoverage, &fgDepth);
            if (fgKind > 1.5) {
                occluded = false;
            } else if (fgKind > 0.5) {
                occluded = fgDepth < u.uFootDepthQ + upright - 1e-4;
            } else {
                occluded = sceneDepth + u.uTolerance < spriteDepth;
            }
        }
    }

    if (u.uDebug > 0.5) {
        if (occluded) { return vec4<f32>(1.0, 0.0, 0.0, 0.7); }
        return vec4<f32>(0.0, 0.0, 1.0, 0.7);
    }

    if (occluded) {
        if (u.uOcclusionBlendFactor < 1e-5) { discard; }
        return vec4<f32>(color.rgb * u.uOcclusionBlendFactor, color.a * u.uOcclusionBlendFactor);
    }

    var rgb = color.rgb;

    // 色调:probe 保亮度白平衡(光环境曲线管线)
    if (u.uToneStrength > 1e-4) {
        let su = clamp(u.uEntityFootWorldX / max(u.uSceneSize.x, 1e-3), 0.0, 1.0);
        let sv = clamp((u.uEntityFootWorldY - u.uSampleLiftWorld) / max(u.uSceneSize.y, 1e-3), 0.0, 1.0);
        let amb = textureSampleLevel(uProbe, uProbeSampler, vec2<f32>(su, sv), 0.0).rgb;
        let net = amb * u.uAmbientIntensity + u.uKeyColor * (u.uKeyIntensity * 0.5);
        let l = max(luma(net), 0.04);
        let wb = clamp(net / l, vec3<f32>(0.5), vec3<f32>(1.7));
        rgb *= mix(vec3<f32>(1.0), wb, u.uToneStrength);
    }

    // AO:sprite 空间纵向梯度(vTextureCoord.y 从 0 顶到 1 底)
    let vy = clamp(vTextureCoord.y, 0.0, 1.0);
    let contact = u.uAOContact * smoothstep(0.78, 1.0, vy);
    let form = u.uAOForm * vy;
    let ao = clamp(1.0 - contact - form, 0.0, 1.0);
    rgb *= ao;

    // 预乘不变量 rgb 不超过 a,杜绝发白 / 发亮
    rgb = min(rgb, vec3<f32>(color.a));
    return vec4<f32>(rgb, color.a);
}
`,id=null;function ad(){return id||=Lt.from({vertex:{source:rd,entryPoint:`mainVertex`},fragment:{source:rd,entryPoint:`mainFragment`}}),id}var od=class e extends $t{constructor(e){let{cfg:t,depthTexture:n,probeSource:r,lightEnv:i,sampleLiftWorld:a}=e,o=!!(t&&n),s=t?.depth_mapping,c=t?.shader,l=n?.source??I.WHITE.source,u=r??I.WHITE.source;super({gpuProgram:ad(),resources:{lightUniforms:{uSceneSize:{value:new Float32Array([0,0]),type:`vec2<f32>`},uProjectionScale:{value:1,type:`f32`},uWorldToPixelX:{value:1,type:`f32`},uWorldToPixelY:{value:1,type:`f32`},uWorldContainerPos:{value:new Float32Array([0,0]),type:`vec2<f32>`},uEntityFootWorldX:{value:0,type:`f32`},uEntityFootWorldY:{value:0,type:`f32`},uSampleLiftWorld:{value:a,type:`f32`},uDepthEnabled:{value:o?1:0,type:`f32`},uInvert:{value:s?.invert?1:0,type:`f32`},uScale:{value:s?.scale??1,type:`f32`},uOffset:{value:s?.offset??0,type:`f32`},uDepthPerSy:{value:c?.depth_per_sy??0,type:`f32`},uFloorOffset:{value:t?.floor_offset??0,type:`f32`},uFloorOffsetExtra:{value:0,type:`f32`},uTolerance:{value:t?.depth_tolerance??0,type:`f32`},uOcclusionBlendFactor:{value:0,type:`f32`},uDebug:{value:0,type:`f32`},uFootDepthQ:{value:0,type:`f32`},uHasFootDepth:{value:0,type:`f32`},uFootBias:{value:.045,type:`f32`},uHasFgCoverage:{value:0,type:`f32`},uKeyColor:{value:new Float32Array(i.key.color),type:`vec3<f32>`},uKeyIntensity:{value:i.key.intensity,type:`f32`},uAmbientColor:{value:new Float32Array(i.ambient.color),type:`vec3<f32>`},uAmbientIntensity:{value:i.ambient.intensity,type:`f32`},uToneStrength:{value:r?i.toneStrength:0,type:`f32`},uAOContact:{value:i.ao.contact,type:`f32`},uAOForm:{value:i.ao.form,type:`f32`}},uDepthMap:l,uDepthMapSampler:Au(l),uProbe:u,uProbeSampler:Au(u),uFgCoverage:I.EMPTY.source,uFgCoverageSampler:Au(I.EMPTY.source)}}),this._isDepthOcclusion=!0}static createForEntity(t){return new e(t)}get _lu(){return this.resources.lightUniforms?.uniforms}setSceneSize(e,t){let n=this._lu;if(n){let r=n.uSceneSize;r[0]=e,r[1]=t}}setWorldToPixel(e,t){let n=this._lu;n&&(n.uWorldToPixelX=e,n.uWorldToPixelY=t)}setProjectionScale(e){let t=this._lu;t&&(t.uProjectionScale=e)}setWorldContainerPos(e,t){let n=this._lu;if(n){let r=n.uWorldContainerPos;r[0]=e,r[1]=t}}setEntityFootY(e){let t=this._lu;t&&(t.uEntityFootWorldY=e)}setEntityFootX(e){let t=this._lu;t&&(t.uEntityFootWorldX=e)}setFloorOffset(e){let t=this._lu;t&&(t.uFloorOffset=e)}setFloorOffsetExtra(e){let t=this._lu;t&&(t.uFloorOffsetExtra=e)}setTolerance(e){let t=this._lu;t&&(t.uTolerance=e)}setOcclusionBlendFactor(e){let t=this._lu;t&&(t.uOcclusionBlendFactor=Math.min(1,Math.max(0,e)))}setFootDepthQ(e){let t=this._lu;if(t){if(e===null||!Number.isFinite(e)){t.uHasFootDepth=0;return}t.uFootDepthQ=e,t.uHasFootDepth=1}}setFootBias(e){let t=this._lu;t&&(t.uFootBias=Math.max(0,e))}setForegroundCoverage(e){let t=this._lu,n=e??I.EMPTY.source,r=this.resources;r.uFgCoverage=n,r.uFgCoverageSampler=Au(n),t&&(t.uHasFgCoverage=e?1:0)}setTone(e){let t=this._lu;t&&(t.uToneStrength=Math.max(0,Math.min(1,e)))}setAO(e,t){let n=this._lu;n&&(n.uAOContact=Math.max(0,Math.min(1,e)),n.uAOForm=Math.max(0,Math.min(1,t)))}setKeyLight(e,t){let n=this._lu;if(n){let r=n.uKeyColor;r[0]=e[0],r[1]=e[1],r[2]=e[2],n.uKeyIntensity=t}}setAmbient(e,t){let n=this._lu;if(n){let r=n.uAmbientColor;r[0]=e[0],r[1]=e[1],r[2]=e[2],n.uAmbientIntensity=t}}setDebug(e){let t=this._lu;t&&(t.uDebug=e?1:0)}};function sd(e,t,n,r,i=128){if(t<=0||n<=0)return null;let a=-1;for(let r=n-1;r>=0&&a<0;r--){let n=r*t*4;for(let o=0;o<t;o++)if(e[n+o*4+3]>=i){a=r;break}}if(a<0)return null;let o=Math.max(0,a-Math.max(1,Math.round(r))+1),s=t,c=-1;for(let n=o;n<=a;n++){let r=n*t*4;for(let n=0;n<t;n++)e[r+n*4+3]>=i&&(n<s&&(s=n),n>c&&(c=n))}return{lo:s/t,hi:(c+1)/t}}function cd(e,t){return t?{lo:1-e.hi,hi:1-e.lo}:e}function ld(e){let t=[],n=[];for(let r of e){if(r===void 0)return;r!==null&&(t.push((r.lo+r.hi)*.5),n.push((r.hi-r.lo)*.5))}if(t.length===0)return null;let r=e=>{e.sort((e,t)=>e-t);let t=e.length>>1;return e.length%2?e[t]:(e[t-1]+e[t])*.5},i=r(t),a=r(n);return{lo:i-a,hi:i+a}}var ud=`none`,dd=new WeakMap;function fd(e,t,n){if(e.length===0)return null;let r=dd.get(e);if(r!==void 0)return r===ud?null:r;let i=ld(e.map(e=>bd(e,t,n)));return i===void 0?null:(dd.set(e,i??ud),i)}var pd=`unreadable`,md=new WeakMap,hd=new WeakSet,gd=new WeakMap,_d=300,vd=null;function yd(e,t){if(typeof document>`u`||!vd&&(vd=document.createElement(`canvas`).getContext(`2d`,{willReadFrequently:!0}),!vd))return null;let n=vd.canvas;return n.width<e&&(n.width=e),n.height<t&&(n.height=t),vd.clearRect(0,0,e,t),vd}function bd(e,t,n){let r=e.source,i=e.frame,a=`${i.x},${i.y},${i.width},${i.height}`,o=md.get(r);o||(o=new Map,md.set(r,o));let s=o.get(a);if(s!==void 0)return s===pd?void 0:s;if(r.resource==null){let e=(gd.get(r)??0)+1;gd.set(r,e),e===_d&&xd(r,`一直没有图像资源`);return}let c=Sd(e,t,n);return o.set(a,c),c===pd&&xd(r,`资源不是可绘制图像或帧旋转过`),c===pd?void 0:c}function xd(e,t){hd.has(e)||(hd.add(e),console.warn(`[接触阴影] 读不到这张图集的像素（${String(e.label||e.uid)}，${t}），贴地范围退回整帧宽——这个角色的接触阴影会比脚宽。`))}function Sd(e,t,n){let r=e.source,i=r.resource;if(e.rotate||!(typeof ImageBitmap<`u`&&i instanceof ImageBitmap||typeof HTMLImageElement<`u`&&i instanceof HTMLImageElement||typeof HTMLCanvasElement<`u`&&i instanceof HTMLCanvasElement||typeof OffscreenCanvas<`u`&&i instanceof OffscreenCanvas))return pd;let a=r.pixelWidth/Math.max(r.width,1e-6),o=Math.round(e.frame.x*a),s=Math.max(1,Math.round(e.frame.width*a)),c=Math.max(1,Math.round(e.frame.height*a)),l=Math.max(1,Math.min(c,Math.round(c*n))),u=Math.round(e.frame.y*a)+c-l,d=yd(s,l);if(!d)return pd;try{d.drawImage(i,o,u,s,l,0,0,s,l);let e=d.getImageData(0,0,s,l).data;return sd(e,s,l,t*c)}catch{return pd}}var Cd=.25,wd=.9,Td=.7,Ed=[`lighting`,`binding`,`scene`],Dd=`lighting`;function Od(e,t,n,r){return typeof e==`number`&&Number.isFinite(e)?Math.max(n,Math.min(r,e)):t}function kd(e){let t=Math.max(1,Math.min(85,e))*Math.PI/180;return .5/Math.tan(t)}function Ad(e,t){let n=e??{};return{enabled:n.enabled!==!1,directional:typeof n.directional==`boolean`?n.directional:!0,dirSource:Ed.includes(n.dirSource)?n.dirSource:Dd,darkness:Od(n.darkness,t.contact,0,1),size:Od(n.size,t.contactSize,0,10),spread:Od(n.spread,Cd,.01,3),dirStrength:Od(n.dirStrength,wd,0,1),dirLength:Od(n.dirLength,Td,.01,10),coneK:kd(Od(n.dirConeDeg,32,1,85))}}(()=>{let e=new Float32Array(65536);for(let t=0;t<65536;t++){let n=t&32768?-1:1,r=t>>10&31,i=t&1023;e[t]=r===0?n*i*2**-24:r===31?i?NaN:n*(1/0):n*(1+i/1024)*2**(r-15)}return e})();var jd={spread:1,widthScale:1},Md=Math.PI/180,Nd=.4,Pd=.42,Fd=.06,Id=.12,Ld=.35,Rd=.2,zd=`
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
};

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
};

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vWorld: vec2<f32>,
    @location(1) vUV: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
    let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    var out: VSOutput;
    out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
    out.vWorld = aPosition;
    out.vUV = aUV;
    return out;
}
`,Bd=`
struct ShadowUniforms {
    uDarkness: f32,
    uShadowColor: vec3<f32>,
    uColEnabled: f32,
    uOccEnabled: f32,
    uShearX: f32,
    uShearY: f32,
    uHalfW: f32,
    uSpreadTop: f32,
    uTipFadeStart: f32,
    uTipAlpha: f32,
    uPenGrow: f32,
    uU0: f32,
    uV0: f32,
    uU1: f32,
    uV1: f32,
    uSceneSize: vec2<f32>,
    uFootX: f32,
    uFootY: f32,
    uW2pX: f32,
    uW2pY: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uFloorOffset: f32,
    uTolerance: f32,
    uOccBlend: f32,
    uGroundMin: f32,
    uGroundMax: f32,
    uHasGroundTex: f32,
    uM_ppu: f32,
    uM_cx: f32,
    uM_cy: f32,
    uM_R00: f32,
    uM_R01: f32,
    uM_R02: f32,
    uM_R20: f32,
    uM_R21: f32,
    uM_R22: f32,
    uCol_xMin: f32,
    uCol_zMin: f32,
    uCol_cell: f32,
    uCol_gw: f32,
    uCol_gh: f32,
};

@group(2) @binding(0) var<uniform> shadowUniforms: ShadowUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uTextureSampler: sampler;
@group(2) @binding(3) var uDepthMap: texture_2d<f32>;
@group(2) @binding(4) var uDepthMapSampler: sampler;
@group(2) @binding(5) var uCollisionMap: texture_2d<f32>;
@group(2) @binding(6) var uCollisionMapSampler: sampler;
@group(2) @binding(7) var uGroundD: texture_2d<f32>;
@group(2) @binding(8) var uGroundDSampler: sampler;

// 地面深度:逐像素取行走面场(与角色脚点同源,见 FRAG_WGSL 头注释)
fn groundDepthAt(wp: vec2<f32>) -> f32 {
    let u = shadowUniforms;
    let uv = vec2<f32>(wp.x / max(u.uSceneSize.x, 1e-3), wp.y / max(u.uSceneSize.y, 1e-3));
    let g = textureSampleLevel(uGroundD, uGroundDSampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
    let t = (g.r * 255.0 * 256.0 + g.g * 255.0) / 65535.0;
    return u.uGroundMin + t * (u.uGroundMax - u.uGroundMin);
}

fn isCollisionAt(wp: vec2<f32>) -> bool {
    let u = shadowUniforms;
    let sx = wp.x * u.uW2pX;
    let sy = wp.y * u.uW2pY;
    let dFloor = groundDepthAt(wp);
    let px = (sx - u.uM_cx) / u.uM_ppu;
    let py = (u.uM_cy - sy) / u.uM_ppu;
    let cwx = u.uM_R00 * px + u.uM_R01 * py + u.uM_R02 * dFloor;
    let cwz = u.uM_R20 * px + u.uM_R21 * py + u.uM_R22 * dFloor;
    let gx = (cwx - u.uCol_xMin) / u.uCol_cell;
    let gz = (cwz - u.uCol_zMin) / u.uCol_cell;
    if (gx < 0.0 || gx >= u.uCol_gw || gz < 0.0 || gz >= u.uCol_gh) { return false; }
    return textureSampleLevel(uCollisionMap, uCollisionMapSampler, vec2<f32>(gx / u.uCol_gw, gz / u.uCol_gh), 0.0).r > 0.5;
}

// 取剪影 alpha,必须 clamp 在当前帧框内(越界采到图集相邻帧 = 条纹复发)
fn silAt(uv: vec2<f32>) -> f32 {
    let u = shadowUniforms;
    let lo = vec2<f32>(min(u.uU0, u.uU1), min(u.uV0, u.uV1));
    let hi = vec2<f32>(max(u.uU0, u.uU1), max(u.uV0, u.uV1));
    return textureSampleLevel(uTexture, uTextureSampler, clamp(uv, lo, hi), 0.0).a;
}

const RING_K: f32 = 0.7071;

// 变半径半影:内圈 8 抽(权 1)+ 外圈 4 抽(权 .5)+ 中心(权 2),权和 12(与 master 的 GLSL 版同序同权)
fn silSoft(uv: vec2<f32>, r: f32) -> f32 {
    if (r < 1e-4) { return silAt(uv); }
    let u = shadowUniforms;
    let rad = r * vec2<f32>(abs(u.uU1 - u.uU0), abs(u.uV1 - u.uV0));
    var sum = silAt(uv) * 2.0
        + silAt(uv + vec2<f32>( rad.x, 0.0))
        + silAt(uv + vec2<f32>(-rad.x, 0.0))
        + silAt(uv + vec2<f32>( 0.0,  rad.y))
        + silAt(uv + vec2<f32>( 0.0, -rad.y))
        + silAt(uv + vec2<f32>( RING_K * rad.x,  RING_K * rad.y))
        + silAt(uv + vec2<f32>(-RING_K * rad.x,  RING_K * rad.y))
        + silAt(uv + vec2<f32>( RING_K * rad.x, -RING_K * rad.y))
        + silAt(uv + vec2<f32>(-RING_K * rad.x, -RING_K * rad.y));
    sum += 0.5 * (
          silAt(uv + vec2<f32>( 2.0 * rad.x, 0.0))
        + silAt(uv + vec2<f32>(-2.0 * rad.x, 0.0))
        + silAt(uv + vec2<f32>( 0.0,  2.0 * rad.y))
        + silAt(uv + vec2<f32>( 0.0, -2.0 * rad.y)));
    return sum / 12.0;
}

@fragment
fn mainFragment(@location(0) vWorld: vec2<f32>) -> @location(0) vec4<f32> {
    let u = shadowUniforms;
    // 梯形反解(见 FRAG_WGSL 头注释):t 是 y 的一次式,与 uSpreadTop 无关
    var offY = u.uShearY;
    if (abs(u.uShearY) < 1e-3) {
        if (u.uShearY < 0.0) { offY = -1e-3; } else { offY = 1e-3; }
    }
    let t = (vWorld.y - u.uFootY) / offY;
    let halfAt = u.uHalfW * mix(1.0, u.uSpreadTop, clamp(t, 0.0, 1.0));
    let s = ((vWorld.x - u.uFootX) - u.uShearX * t) / max(halfAt * 2.0, 1e-3) + 0.5;
    if (t < 0.0 || t > 1.0 || s < 0.0 || s > 1.0) { discard; }
    let uv = vec2<f32>(mix(u.uU0, u.uU1, s), mix(u.uV0, u.uV1, t));
    let sil = silSoft(uv, u.uPenGrow * t);
    if (sil < 0.01) { discard; }
    var a = sil * u.uDarkness * mix(1.0, u.uTipAlpha, smoothstep(u.uTipFadeStart, 1.0, t));

    // 碰撞方向阻挡:从脚底沿投射方向 march,撞到碰撞格则其后整段裁掉
    if (u.uColEnabled > 0.5 && u.uHasGroundTex > 0.5) {
        let foot = vec2<f32>(u.uFootX, u.uFootY);
        let d = vWorld - foot;
        var blocked = false;
        for (var i = 1; i <= 24; i++) {
            if (isCollisionAt(foot + d * (f32(i) / 24.0))) { blocked = true; break; }
        }
        if (blocked) { discard; }
    }

    // 前景遮挡 blend
    if (u.uOccEnabled > 0.5 && u.uHasGroundTex > 0.5) {
        let dUV = vec2<f32>(vWorld.x / u.uSceneSize.x, vWorld.y / u.uSceneSize.y);
        if (dUV.x >= 0.0 && dUV.x <= 1.0 && dUV.y >= 0.0 && dUV.y <= 1.0) {
            let ds = textureSampleLevel(uDepthMap, uDepthMapSampler, dUV, 0.0);
            let rawD = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
            var dRaw = rawD;
            if (u.uInvert > 0.5) { dRaw = 1.0 - rawD; }
            let sceneDepth = dRaw * u.uScale + u.uOffset;
            let shadowDepth = groundDepthAt(vWorld) + u.uFloorOffset;
            if (sceneDepth + u.uTolerance < shadowDepth) { a *= u.uOccBlend; }
        }
    }

    return vec4<f32>(u.uShadowColor, a);
}
`;function W(e){return{value:e,type:`f32`}}var Vd=`
struct ContactUniforms {
    uDarkness: f32,
    uShadowColor: vec3<f32>,
    uFootX: f32,
    uFootY: f32,
    uAxisOffX: f32,
    uRadiusWu: f32,
    uHeightWu: f32,
    uNearField: f32,
    uConeK: f32,
    uDirReach: f32,
    uDirWeight: f32,
    uGroundFeather: f32,
    uS0X: f32,
    uS0Y: f32,
    uS0Z: f32,
    uS0W: f32,
    uS0P: f32,
    uS1X: f32,
    uS1Y: f32,
    uS1Z: f32,
    uS1W: f32,
    uS1P: f32,
    uS2X: f32,
    uS2Y: f32,
    uS2Z: f32,
    uS2W: f32,
    uS2P: f32,
    uS3X: f32,
    uS3Y: f32,
    uS3Z: f32,
    uS3W: f32,
    uS3P: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uFloorOffset: f32,
    uTolerance: f32,
    uHasDepth: f32,
    uWuPerQ: f32,
    uGroundMin: f32,
    uGroundMax: f32,
    uGroundW: f32,
    uGroundH: f32,
    uHasGroundTex: f32,
    uSceneSize: vec2<f32>,
    uW2pX: f32,
    uW2pY: f32,
    uM_ppu: f32,
    uM_cx: f32,
    uM_cy: f32,
    uM_R00: f32,
    uM_R01: f32,
    uM_R02: f32,
    uM_R10: f32,
    uM_R11: f32,
    uM_R12: f32,
    uM_R20: f32,
    uM_R21: f32,
    uM_R22: f32,
};

@group(2) @binding(0) var<uniform> shadowUniforms: ContactUniforms;
@group(2) @binding(1) var uGroundD: texture_2d<f32>;
@group(2) @binding(2) var uGroundDSampler: sampler;
@group(2) @binding(3) var uDepthMap: texture_2d<f32>;
@group(2) @binding(4) var uDepthMapSampler: sampler;

const PI: f32 = 3.14159265;

// 行走面深度场第 (i, j) 个纹素(RG16 打包,解码到 0..1)
fn groundTexel(i: f32, j: f32) -> f32 {
    let u = shadowUniforms;
    let sz = vec2<f32>(max(u.uGroundW, 1.0), max(u.uGroundH, 1.0));
    let g = textureSampleLevel(uGroundD, uGroundDSampler, (clamp(vec2<f32>(i, j), vec2<f32>(0.0), sz - 1.0) + 0.5) / sz, 0.0);
    return (g.r * 255.0 * 256.0 + g.g * 255.0) / 65535.0;
}

// 行走面深度场在场景 px 处的深度(q.z),手写双线性(与 CPU sampleGroundField 同口径:纹素 i 在 work px = i 处)。
// 打包值不能交给硬件插值(高低字节分开插 = 错值),纹理只能 nearest;直接 nearest 取,地面点按约 10 屏幕 px
// 一级阶梯还原,胶囊 AO 在脚下画出方块硬边(2026-09-24 真机)
fn groundDepthAt(wp: vec2<f32>) -> f32 {
    let u = shadowUniforms;
    let uv = clamp(vec2<f32>(wp.x / max(u.uSceneSize.x, 1e-3), wp.y / max(u.uSceneSize.y, 1e-3)), vec2<f32>(0.0), vec2<f32>(1.0));
    let sz = vec2<f32>(max(u.uGroundW, 1.0), max(u.uGroundH, 1.0));
    let t = clamp(uv * sz, vec2<f32>(0.0), sz - 1.001);
    let i0 = floor(t);
    let f = t - i0;
    let a = mix(groundTexel(i0.x, i0.y), groundTexel(i0.x + 1.0, i0.y), f.x);
    let b = mix(groundTexel(i0.x, i0.y + 1.0), groundTexel(i0.x + 1.0, i0.y + 1.0), f.x);
    return u.uGroundMin + mix(a, b, f.y) * (u.uGroundMax - u.uGroundMin);
}

// 场景 px 到该处地面的 M-world 坐标(wu);有行走面深度场取它,没有就按世界 y=0 的平地解深度
fn groundWorldWu(wp: vec2<f32>) -> vec3<f32> {
    let u = shadowUniforms;
    let px = (wp.x * u.uW2pX - u.uM_cx) / u.uM_ppu;
    let py = (u.uM_cy - wp.y * u.uW2pY) / u.uM_ppu;
    var d: f32;
    if (u.uHasGroundTex > 0.5) {
        d = groundDepthAt(wp);
    } else {
        var r12 = 1e-6;
        if (abs(u.uM_R12) > 1e-6) { r12 = u.uM_R12; }
        d = -(u.uM_R10 * px + u.uM_R11 * py) / r12;
    }
    let w = vec3<f32>(u.uM_R00 * px + u.uM_R01 * py + u.uM_R02 * d,
                      u.uM_R10 * px + u.uM_R11 * py + u.uM_R12 * d,
                      u.uM_R20 * px + u.uM_R21 * py + u.uM_R22 * d);
    return w * u.uWuPerQ;
}

// 无方向部分:竖直胶囊(轴在地面点水平距离 x 处,半径 r,底端球心高 r、顶端球心高 top)对地面点的
// 余弦加权遮蔽 (1/π)∫cos(天顶角)dω。按方位角切成竖直半平面:每个半平面里胶囊的截面是一个 2D 胶囊
// (两个圆 + 中间竖条,半宽 w = sqrt(r² − p²),p = 这个方位离轴的垂距,圆心在 m = x·cos 方位处、高 r 与 top),
// 截面是凸的,从地面点看被挡的仰角是一整段 [lo, hi](lo 贴底圆下切线,hi 贴顶圆上切线;竖条跨过头顶时 hi = 90°),
// 余弦加权就是 (sin²hi − sin²lo)/2;再对方位角中点求积。x > r 时只有 |方位| < asin(r/x) 挨得着,x ≤ r 时整圈。
// 8 片与蒙特卡洛精确积分差 < 0.006(x=0 → 1、x=r → 0.354、x=2r → 0.149);编辑器预览
// light_env_visual._omni 同式,对账测试钉着这几个值。
// 两处分支写成 if / else 而不是 select:select 两边都求值,x 不大于 r 时 asin(r / x) 在定义域外
// (与 master 的 GLSL 版三元式短路逐式相同,字面量先后也不变)
const OMNI_SLICES: i32 = 8;
fn capsuleOmni(x: f32, r: f32, top: f32) -> f32 {
    var pm: f32;
    if (x > r) { pm = asin(r / x); } else { pm = PI; }
    let dphi = 2.0 * pm / f32(OMNI_SLICES);
    var acc = 0.0;
    for (var i = 0; i < OMNI_SLICES; i++) {
        let phi = -pm + (f32(i) + 0.5) * dphi;
        let m = x * cos(phi);
        let p = x * sin(phi);
        let w2 = r * r - p * p;
        if (w2 > 0.0) {
            let w = sqrt(w2);
            let lo = max(0.0, atan2(r, m) - asin(min(1.0, w / length(vec2<f32>(m, r)))));
            var hi: f32;
            if (m - w <= 0.0) { hi = 0.5 * PI; } else { hi = min(0.5 * PI, atan2(top, m) + asin(min(1.0, w / length(vec2<f32>(m, top))))); }
            if (hi > lo) {
                let sh = sin(hi);
                let sl = sin(lo);
                acc += 0.5 * (sh * sh - sl * sl);
            }
        }
    }
    return acc * dphi / PI;
}

// 射线 ro + rd * t 上 t 处这一点对胶囊(线段 ca 到 ca + ba,半径 r)的锥形软遮挡 0..1,含沿射线的淡出。
// 这一点离胶囊表面 d、离地面点 t:d / t 就是它偏离光锥中心线的角度(k = 0.5 / tan 锥角)
fn capsuleOccAt(ro: vec3<f32>, rd: vec3<f32>, ca: vec3<f32>, ba: vec3<f32>, baba: f32, r: f32, k: f32, reach: f32, t0: f32) -> f32 {
    let t = max(t0, 1e-4);
    let q = ro + rd * t;
    let h = clamp(dot(q - ca, ba) / baba, 0.0, 1.0);
    let d = length(q - ca - ba * h) - r;
    let s = clamp(k * d / t + 0.5, 0.0, 1.0);
    let f = t / reach;
    return (1.0 - s * s * (3.0 - 2.0 * s)) * exp(-f * f);
}

// 胶囊锥形软阴影(方向部分)= 射线上几个样本点的遮挡取最大(每个都是真实的一点,只会逼近真值、不会多算):
// 1. 射线与胶囊轴两直线的最近点:影子主体由它给,轴上最近点落在线段内时与原 Quilez 胶囊软阴影同值;
//    光与轴近乎平行时这一解病态,跳过。
// 2. 射线正对胶囊底、腰、顶的三点:光近乎头顶时,锥形半影其实由胶囊顶给(遮挡角约为 离轴距离 / 身高);
//    只算第 1 点时只有恰好在顶部高度掠过的一条窄带拿得到半影,脚下画出一条横线
//    (2026-09-24 真机:仰角 84° 到 89° 时一条宽几 px、长约一个身高的暗线)
fn capsuleDirOcc(ro: vec3<f32>, rd: vec3<f32>, ca: vec3<f32>, cb: vec3<f32>, r: f32, k: f32, reach: f32) -> f32 {
    let ba = cb - ca;
    let baba = max(dot(ba, ba), 1e-6);
    let dba = dot(rd, ba);
    let den = baba - dba * dba;
    var occ = 0.0;
    if (den > 1e-4 * baba) {
        let oa = ro - ca;
        let t0 = (-dot(oa, rd) * baba + dba * dot(oa, ba)) / den;
        occ = capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, t0);
    }
    occ = max(occ, capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, dot(ca - ro, rd)));
    occ = max(occ, capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, dot(ca + 0.5 * ba - ro, rd)));
    occ = max(occ, capsuleOccAt(ro, rd, ca, ba, baba, r, k, reach, dot(cb - ro, rd)));
    return occ;
}

const MIN_EL: f32 = ${(25*Math.PI/180).toFixed(6)};

// 指向光的向量到单位向量,仰角只钳下限(与 contactAoSources.clampAoElevation 同式,正上方原样)
fn aoLightDir(v: vec3<f32>) -> vec3<f32> {
    let hn = length(v.xz);
    if (hn < 1e-6) { return vec3<f32>(0.0, 1.0, 0.0); }
    let el = max(MIN_EL, atan2(v.y, hn));
    return vec3<f32>(v.x / hn * cos(el), sin(el), v.z / hn * cos(el));
}

// 一路光对地面点 P 的方向遮挡:灯位型逐像素朝灯(站在灯下走过去影子逐像素跟着转),方向型用定向
fn sourceOcc(P: vec3<f32>, sx: f32, sy: f32, sz: f32, isPoint: f32, ca: vec3<f32>, cb: vec3<f32>, reach: f32) -> f32 {
    let u = shadowUniforms;
    var v = vec3<f32>(sx, sy, sz);
    if (isPoint > 0.5) { v = v - P; }
    return capsuleDirOcc(P, aoLightDir(v), ca, cb, u.uRadiusWu, u.uConeK, reach);
}

@fragment
fn mainFragment(@location(0) vWorld: vec2<f32>) -> @location(0) vec4<f32> {
    let u = shadowUniforms;
    // 这个像素看到的不是地面(墙、桶、屋顶挡在该处地面点前面)就说明地上的 AO 被挡住,淡掉。
    // 判据与 cast 的前景遮挡同一个(场景深度 vs 行走面深度,留容差,见 entity-lighting「深度自比较」);
    // 从容差开始、再近 uGroundFeather 才完全不画——一刀切在深度图画宽了的细遮挡物(灯杆)旁挖一圈硬边。
    // 2026-09-24 实测:不判的话队伍身后的木桶、墙面、前景瓦面都被压暗
    var onGround = 1.0;
    if (u.uHasDepth > 0.5) {
        let dUV = vec2<f32>(vWorld.x / max(u.uSceneSize.x, 1e-3), vWorld.y / max(u.uSceneSize.y, 1e-3));
        if (dUV.x >= 0.0 && dUV.x <= 1.0 && dUV.y >= 0.0 && dUV.y <= 1.0) {
            let ds = textureSampleLevel(uDepthMap, uDepthMapSampler, dUV, 0.0);
            let rawD = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
            var dRaw = rawD;
            if (u.uInvert > 0.5) { dRaw = 1.0 - rawD; }
            let sceneDepth = dRaw * u.uScale + u.uOffset;
            let nearer = groundDepthAt(vWorld) + u.uFloorOffset - sceneDepth;
            onGround = 1.0 - smoothstep(u.uTolerance, u.uTolerance + max(u.uGroundFeather, 1e-4), nearer);
            if (onGround < 0.003) { discard; }
        }
    }

    let P = groundWorldWu(vWorld);
    let F = groundWorldWu(vec2<f32>(u.uFootX + u.uAxisOffX, u.uFootY));
    let away = normalize(vec3<f32>(u.uM_R01, 0.0, u.uM_R21));
    let base = F + away * u.uRadiusWu;

    let x = length(P.xz - base.xz);
    let he = u.uHeightWu * u.uNearField;
    let omni = capsuleOmni(x, u.uRadiusWu, max(he, u.uRadiusWu));

    // 有方向部分:每一路光各投各的胶囊软影,按它占地面照度的比例加权(权重和不超过 1)
    var dirOcc = 0.0;
    if (u.uS0W + u.uS1W + u.uS2W + u.uS3W > 0.0) {
        let ca = base + vec3<f32>(0.0, u.uRadiusWu, 0.0);
        let cb = base + vec3<f32>(0.0, max(u.uHeightWu - u.uRadiusWu, u.uRadiusWu * 1.01), 0.0);
        let reach = max(u.uHeightWu * u.uDirReach, 1e-3);
        if (u.uS0W > 0.0) { dirOcc += u.uS0W * sourceOcc(P, u.uS0X, u.uS0Y, u.uS0Z, u.uS0P, ca, cb, reach); }
        if (u.uS1W > 0.0) { dirOcc += u.uS1W * sourceOcc(P, u.uS1X, u.uS1Y, u.uS1Z, u.uS1P, ca, cb, reach); }
        if (u.uS2W > 0.0) { dirOcc += u.uS2W * sourceOcc(P, u.uS2X, u.uS2Y, u.uS2Z, u.uS2P, ca, cb, reach); }
        if (u.uS3W > 0.0) { dirOcc += u.uS3W * sourceOcc(P, u.uS3X, u.uS3Y, u.uS3Z, u.uS3P, ca, cb, reach); }
        dirOcc *= u.uDirWeight;
    }

    let alpha = onGround * u.uDarkness * (1.0 - (1.0 - omni) * (1.0 - dirOcc));
    if (alpha < 0.003) { discard; }
    return vec4<f32>(u.uShadowColor, alpha);
}
`,Hd=Array.from({length:4},(e,t)=>[`X`,`Y`,`Z`,`W`,`P`].map(e=>`uS${t}${e}`));function Ud(){let e={};for(let t of Hd)for(let n of t)e[n]=W(0);return e}function Wd(e){let t=zd+e;return{vertex:{source:t,entryPoint:`mainVertex`},fragment:{source:t,entryPoint:`mainFragment`}}}function Gd(e){let t=e?.groundTexture??I.WHITE.source,n=e?.depthTexture?.source??I.WHITE.source;return qt.from({gpu:Wd(Vd),resources:{shadowUniforms:{uDarkness:W(.75),uShadowColor:{value:new Float32Array([0,0,0]),type:`vec3<f32>`},uFootX:W(0),uFootY:W(0),uAxisOffX:W(0),uRadiusWu:W(1),uHeightWu:W(1),uNearField:W(Cd),uConeK:W(kd(32)),uDirReach:W(Td),uDirWeight:W(wd),uGroundFeather:W(Rd),...Ud(),uInvert:W(e?.invert??0),uScale:W(e?.scale??1),uOffset:W(e?.offset??0),uFloorOffset:W(e?.floorOffset??0),uTolerance:W(e?.tolerance??0),uHasDepth:W(e?.groundTexture&&e?.depthTexture?1:0),uWuPerQ:W(1),uGroundMin:W(e?.groundMin??0),uGroundMax:W(e?.groundMax??1),uGroundW:W(e?.groundTexture?.pixelWidth??1),uGroundH:W(e?.groundTexture?.pixelHeight??1),uHasGroundTex:W(e?.groundTexture?1:0),uSceneSize:{value:new Float32Array([e?.sceneW??1,e?.sceneH??1]),type:`vec2<f32>`},uW2pX:W(e?.worldToPixelX??1),uW2pY:W(e?.worldToPixelY??1),uM_ppu:W(e?.ppu??1),uM_cx:W(e?.cx??0),uM_cy:W(e?.cy??0),uM_R00:W(e?.r00??1),uM_R01:W(e?.r01??0),uM_R02:W(e?.r02??0),uM_R10:W(e?.r10??0),uM_R11:W(e?.r11??1),uM_R12:W(e?.r12??0),uM_R20:W(e?.r20??0),uM_R21:W(e?.r21??0),uM_R22:W(e?.r22??1)},uGroundD:t,uGroundDSampler:Au(t),uDepthMap:n,uDepthMapSampler:Au(n)}})}function Kd(e,t){let n=!!e,r=e?.depthTexture?.source??I.WHITE.source,i=e?.collisionTexture?.source??I.WHITE.source,a=e?.groundTexture??I.WHITE.source;return qt.from({gpu:Wd(Bd),resources:{shadowUniforms:{uDarkness:W(.4),uShadowColor:{value:new Float32Array([0,0,0]),type:`vec3<f32>`},uColEnabled:W(n&&e.collisionTexture?1:0),uOccEnabled:W(n?1:0),uShearX:W(0),uShearY:W(1),uHalfW:W(1),uSpreadTop:W(1),uTipFadeStart:W(Nd),uTipAlpha:W(Pd),uPenGrow:W(Fd),uU0:W(0),uV0:W(1),uU1:W(1),uV1:W(0),uSceneSize:{value:new Float32Array([e?.sceneW??1,e?.sceneH??1]),type:`vec2<f32>`},uFootX:W(0),uFootY:W(0),uW2pX:W(e?.worldToPixelX??1),uW2pY:W(e?.worldToPixelY??1),uInvert:W(e?.invert??0),uScale:W(e?.scale??1),uOffset:W(e?.offset??0),uFloorOffset:W(e?.floorOffset??0),uTolerance:W(e?.tolerance??0),uOccBlend:W(e?.occlusionBlendFactor??.28),uGroundMin:W(e?.groundMin??0),uGroundMax:W(e?.groundMax??1),uHasGroundTex:W(e?.groundTexture?1:0),uM_ppu:W(e?.ppu??1),uM_cx:W(e?.cx??0),uM_cy:W(e?.cy??0),uM_R00:W(e?.r00??0),uM_R01:W(e?.r01??0),uM_R02:W(e?.r02??0),uM_R20:W(e?.r20??0),uM_R21:W(e?.r21??0),uM_R22:W(e?.r22??0),uCol_xMin:W(e?.colXMin??0),uCol_zMin:W(e?.colZMin??0),uCol_cell:W(e?.colCellSize??1),uCol_gw:W(e?.colGridW??0),uCol_gh:W(e?.colGridH??0)},uTexture:t,uTextureSampler:Au(t),uDepthMap:r,uDepthMapSampler:Au(r),uCollisionMap:i,uCollisionMapSampler:Au(i),uGroundD:a,uGroundDSampler:Au(a)}})}function G(e,t,n){let r=e.resources.shadowUniforms;r?.uniforms&&(r.uniforms[t]=n,r.update?.())}var qd=class{constructor(e,t){this.blur=null,this.lastSoftness=-1,this.boundSource=null,this.ctx=t??null;let n=()=>new Uint32Array([0,1,2,0,2,3]);this.castPositions=new Float32Array(8),this.castUVs=new Float32Array(8),this.castGeometry=new Yt({positions:this.castPositions,uvs:this.castUVs,indices:n()}),this.castShader=Kd(this.ctx,I.WHITE.source),this.castMesh=new Zt({geometry:this.castGeometry,shader:this.castShader,texture:I.WHITE}),this.castMesh.visible=!1,e.addChild(this.castMesh),this.contactPositions=new Float32Array(8);let r=new Float32Array([0,0,1,0,1,1,0,1]);this.contactGeometry=new Yt({positions:this.contactPositions,uvs:r,indices:n()}),this.contactShader=Gd(this.ctx),this.contactMesh=new Zt({geometry:this.contactGeometry,shader:this.contactShader,texture:I.WHITE}),this.contactMesh.visible=!1,e.addChild(this.contactMesh)}update(e,t,n,r,i){let a=e.getTexture();if(!a||!e.isVisible()||!t.shadow.enabled){this.castMesh.visible=!1,this.contactMesh.visible=!1;return}let o=e.getFootX(),s=e.getFootY(),c=Math.max(1,e.getWorldWidth()),l=Math.max(1,e.getWorldHeight());this.contactMesh.visible=this.updateContact(e,t,a,o,s,c,l,i??null);let u=a.source;u!==this.boundSource&&(this.castShader.resources.uTexture=u,this.castShader.resources.uTextureSampler=Au(u),this.castMesh.texture=a,this.boundSource=u);let d=a.frame,f=u.width||1,p=u.height||1,m=d.x/f,h=(d.x+d.width)/f;if(e.getFacing()<0){let e=m;m=h,h=e}let g=d.y/p,_=(d.y+d.height)/p;if(t.shadow.darkness<=0){this.castMesh.visible=!1;return}this.castMesh.visible=!0;let v=n?n.sample(o,s):{angleRad:(t.key.azimuthDeg+180)*Md,length:t.shadow.length},y=r??jd,b=Number.isFinite(y.spread)?Math.max(.2,y.spread):1,x=Number.isFinite(y.widthScale)?Math.max(.05,y.widthScale):1,S=Math.max(.5,c*.5*x),C=S*b,w=l*v.length,T=Math.cos(v.angleRad)*w,E=Math.sin(v.angleRad)*w,D=this.castPositions;D[0]=o-S,D[1]=s,D[2]=o+S,D[3]=s,D[4]=o+C+T,D[5]=s+E,D[6]=o-C+T,D[7]=s+E,this.castGeometry.getBuffer(`aPosition`).update(),G(this.castShader,`uDarkness`,Math.max(0,Math.min(1,t.shadow.darkness))),G(this.castShader,`uFootX`,o),G(this.castShader,`uFootY`,s),G(this.castShader,`uShearX`,T),G(this.castShader,`uShearY`,E),G(this.castShader,`uHalfW`,S),G(this.castShader,`uSpreadTop`,b),G(this.castShader,`uU0`,m),G(this.castShader,`uV0`,_),G(this.castShader,`uU1`,h),G(this.castShader,`uV1`,g);let O=t.shadow.softness;if(O>0){let e=Math.max(.5,O*4);this.blur?Math.abs(O-this.lastSoftness)>.001&&(this.blur.strength=e,this.lastSoftness=O):(this.blur=new on({strength:e,quality:2}),this.castMesh.filters=[this.blur],this.lastSoftness=O)}else this.blur&&(this.castMesh.filters=[],this.blur.destroy(),this.blur=null,this.lastSoftness=-1)}updateContact(e,t,n,r,i,a,o,s){let c=this.ctx,l=s?.ao??Ad(null,t.shadow);if(!c||!l.enabled||l.darkness<=0||l.size<=0)return!1;let u=bd(n,Id,Ld);if(u===null)return!1;let d=cd(fd(e.getBodyReferenceFrames?.()??[],.12,.35)??u??{lo:0,hi:1},e.getFacing()<0),f=s&&s.wuPerQUnit>0?s.wuPerQUnit:1,{ppu:p,worldToPixelX:m,worldToPixelY:h}=c,g=m/(p*Math.max(Math.hypot(c.r00,c.r01),1e-6)),_=h/(p*Math.max(Math.hypot(c.r10,c.r11),1e-6)),v=Math.max(.001,.5*(d.hi-d.lo)*a*g*f*l.size),y=Math.max(v*2,o*_*f),b=((d.lo+d.hi)*.5-.5)*a,x=(e,t)=>{let n=(c.r00*e+c.r20*t)/f,r=(c.r01*e+c.r21*t)/f;return[n*p/m,-r*p/h]},S=2*y*l.spread+2*v,C=[[0,v]],w=l.directional&&s?s.sources.slice(0,4):[];for(let e of w){let t=e.footDir,n=Math.min(2*y*l.dirLength,y/Math.max(t[1],.3)+v);S=Math.max(S,v+Math.min(4*y,.5*n/Math.max(l.coneK,.001)));let r=Math.hypot(t[0],t[2]);if(r>1e-6){let e=Math.min(y*(r/Math.max(t[1],.001)),2*y*l.dirLength);C.push([-(t[0]/r)*e,v-t[2]/r*e])}}let T=1/0,E=-1/0,D=1/0,O=-1/0;for(let[e,t]of C)for(let n of[-1,1])for(let r of[-1,1]){let[i,a]=x(e+n*S,t+r*S);i<T&&(T=i),i>E&&(E=i),a<D&&(D=a),a>O&&(O=a)}let k=r+b,A=this.contactPositions;A[0]=k+T,A[1]=i+D,A[2]=k+E,A[3]=i+D,A[4]=k+E,A[5]=i+O,A[6]=k+T,A[7]=i+O,this.contactGeometry.getBuffer(`aPosition`).update();let j=this.contactShader;G(j,`uDarkness`,l.darkness),G(j,`uNearField`,l.spread),G(j,`uConeK`,l.coneK),G(j,`uDirReach`,l.dirLength),G(j,`uDirWeight`,l.dirStrength),G(j,`uFootX`,r),G(j,`uFootY`,i),G(j,`uAxisOffX`,b),G(j,`uRadiusWu`,v),G(j,`uHeightWu`,y),G(j,`uWuPerQ`,f);for(let e=0;e<Hd.length;e++){let t=w[e],[n,r,i,a,o]=Hd[e];G(j,a,t?Math.max(0,t.weight):0),t&&(G(j,n,t.x),G(j,r,t.y),G(j,i,t.z),G(j,o,t.point?1:0))}return!0}setDepthParams(e,t,n){G(this.castShader,`uTolerance`,e),G(this.castShader,`uFloorOffset`,t),G(this.castShader,`uOccBlend`,n),G(this.contactShader,`uTolerance`,e),G(this.contactShader,`uFloorOffset`,t)}setShadowColor(e){for(let t of[this.castShader,this.contactShader]){let n=t.resources.shadowUniforms;if(n?.uniforms){let t=n.uniforms.uShadowColor;t[0]=e[0],t[1]=e[1],t[2]=e[2],n.update?.()}}}destroy(){this.blur&&=(this.blur.destroy(),null),this.castMesh.destroy(),this.castShader.destroy(),this.castGeometry.destroy(),this.contactMesh.destroy(),this.contactShader.destroy(),this.contactGeometry.destroy()}},K=e=>document.getElementById(e),Jd=e=>String(e??``).replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#39;`);function Yd(e,t){let n=new URL(e,window.location.href);return t!=null&&String(t)&&n.searchParams.set(`v`,String(t)),n.href}var q,J,Y=null,Xd,Zd,Qd,$d,X=null,ef=null,tf=[],Z=null,nf=!1,rf=null,Q=null,af=null,$=``,of=!0,sf=!0,cf=1,lf=1,uf=1,df=!1,ff=0,pf=``,mf=!1,hf=!0;function gf(e){let t=Math.max(.001,Math.min(1e5,Number(e)||1)),n=K(`zoom`);t>Number(n.max)&&(n.max=String(Math.ceil(t*1.2))),t<Number(n.min)&&(n.min=String(t)),uf=t,n.value=String(t)}var _f=null,vf=null,yf=null,bf=``,xf=null,Sf=null,Cf=null,wf=null,Tf=[];async function Ef(){let e=new ma;try{await e.init({backgroundAlpha:0,antialias:!0,resizeTo:K(`stageWrap`)})}catch(e){return Df(e),!1}return q=e,K(`stage`).appendChild(q.canvas),Y=new ut,Y.visible=!1,q.stage.addChild(Y),Xd=new Rc,q.stage.addChild(Xd),J=new Ye,q.stage.addChild(J),Qd=new Ye,J.addChild(Qd),$d=new Ye,J.addChild($d),Zd=new Rc,q.stage.addChild(Zd),q.ticker.add(()=>Ff(q.ticker.deltaMS/1e3)),new ResizeObserver(()=>{q.resize(),kf()}).observe(K(`stageWrap`)),kf(),Of(document.getElementById(`previewPage`)?.classList.contains(`active`)===!0),!0}function Df(e){let t=e instanceof Error?e.message:String(e??``),n=document.createElement(`div`);n.className=`renderer-unavailable`,n.style.cssText=`position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--fg);background:var(--bg);`;let r=document.createElement(`b`);r.style.color=`var(--warn)`,r.textContent=`游戏真实渲染预览不可用：此浏览器没有可用的 WebGPU`;let i=document.createElement(`div`);i.className=`muted`,i.textContent=`预览用的是游戏同一套渲染器（engine2d，只支持 WebGPU，没有 WebGL 回落）。请用开启了 WebGPU 的 Chrome / Edge 打开（需要 localhost 或 https）。资源流程与人工装配两页不受影响。`;let a=document.createElement(`div`);a.className=`mono muted`,a.textContent=t,n.append(r,i,a),K(`stage`).replaceChildren(n),K(`stageInfo`).textContent=``,console.error(`[anim_preview] 渲染器初始化失败(WebGPU 不可用):`,e)}function Of(e){if(mf=e,q){if(!e){q.ticker.stop();return}q.ticker.start(),requestAnimationFrame(()=>{!mf||!q||(q.resize(),kf(),hf&&Q&&(K(`bg`).value===`scene`&&wf?(gf(Af()),kf()):op(),hf=!1))})}}function kf(){q&&(jf(),Mf(q.renderer.width,q.renderer.height))}function Af(){let e=q?q.renderer.height:800;return Q?Math.max(.02,e*.55/Q.worldHeight):1}function jf(){let e=q.renderer.width,t=q.renderer.height;if(K(`bg`).value===`scene`&&wf&&Q&&Y?.texture&&Y.texture.width>1){let n=Y.texture.width,r=uf,i=e/2,a=t*.66;J.x=i-wf.spawnX*r,J.y=a-wf.spawnY*r;let o=r*wf.worldWidth/n;Y.scale.set(o),Y.x=J.x+(wf.bgX||0)*r,Y.y=J.y+(wf.bgY||0)*r,X&&(X.x=wf.spawnX,X.y=wf.spawnY)}else J.x=Math.round(e/2),J.y=Math.round(t*.72),X&&(X.x=0,X.y=0)}function Mf(e,t){let n=K(`bg`).value;if(Y&&(Y.visible=n===`scene`&&!!Y.texture&&Y.texture.width>1),Xd.clear(),!(n===`transparent`||n===`scene`)){if(n===`grey`){Xd.rect(0,0,e,t).fill(8421504);return}if(n===`sceneColor`){Xd.rect(0,0,e,t).fill(3820122);return}for(let n=0;n<t;n+=16)for(let t=0;t<e;t+=16)Xd.rect(t,n,16,16).fill(t/16+n/16&1?2765634:2239031)}}async function Nf(e){if(!(!Y||!e))try{Y.texture=await po.load(e.bgUrl),wf=e,gf(Af()),kf()}catch{lp(`场景加载失败`)}}async function Pf(){try{Tf=(await fetch(`/api/anim/scenes`).then(e=>e.json())).scenes||[],K(`sceneBg`).replaceChildren(...Tf.map((e,t)=>{let n=document.createElement(`option`);return n.value=String(t),n.textContent=`${e.name} · ${e.id}`,n}))}catch{}}function Ff(e){if(X&&$){let t=!!Q?.states?.[$]?.loop;if(of){X.setPlaying(!0),X.update(e*cf);let n=X.getFrameIndex(),r=X.getFrameCount();n>=r-1&&r>1&&(sf?t||X.setFrameIndex(0):ap(!1))}else X.setPlaying(!1);if(K(`pdm`).checked){let e=parseFloat(K(`dbg`).value)||1;X.applyPixelDensityMatch({x:e,y:e},1)}xf&&of&&(xf.setPlaying(!0),xf.update(e*cf)),J.scale.set(uf),Uf(),Gf(),Lf(),If()}}function If(){if(Zd.clear(),!X||!Q)return;let e=J.x+X.x*uf,t=J.y+X.y*uf,n=Q.worldWidth*uf,r=Q.worldHeight*uf;K(`ovCell`).checked&&Zd.rect(e-n/2,t-r,n,r).stroke({color:5217791,width:1,alpha:.7}),K(`ovAnchor`).checked&&(Zd.moveTo(e-12,t).lineTo(e+12,t).moveTo(e,t-12).lineTo(e,t+12).stroke({color:16731469,width:1.5}),Zd.circle(e,t,3).fill({color:16731469,alpha:.9}))}function Lf(){if(!X)return;let e=X.getFrameIndex(),t=X.getFrameCount();K(`frameLabel`).textContent=`${e+1}/${t}`,df||(K(`timeline`).value=String(e));let n=rf?.isWorkbenchCandidate?`工作台 H 候选（未发布）`:`已发布资源`;K(`stageInfo`).textContent=`${n} · ${rf?.label||rf?.id||``} · ${$} · 帧 ${e+1}/${t} · 世界 ${Q.worldWidth}×${Q.worldHeight} · zoom ${uf.toFixed(2)}`}function Rf(e){let t=parseInt(e.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}function zf(){let e=K(`shadowMode`).value;return{key:{azimuthDeg:+K(`lAzi`).value,elevationDeg:+K(`lElev`).value,color:Rf(K(`lKey`).value),intensity:+K(`lKeyI`).value},ambient:{color:Rf(K(`lAmb`).value),intensity:+K(`lAmbI`).value},shadow:{mode:e,enabled:e!==`off`,darkness:+K(`sDark`).value,softness:.5,length:+K(`sLen`).value,contact:.35,contactSize:1,softSamples:1,softRadius:0,billboard:`light`},toneStrength:+K(`lTone`).value,toneEnabled:+K(`lTone`).value>0,ao:{contact:+K(`lAoC`).value,form:+K(`lAoF`).value}}}function Bf(e){let t=document.createElement(`canvas`);t.width=t.height=4;let n=t.getContext(`2d`);return n.fillStyle=`rgb(${Math.round(e[0]*255)},${Math.round(e[1]*255)},${Math.round(e[2]*255)})`,n.fillRect(0,0,4,4),I.from(t)}function Vf(){if(!X||!Q)return;let e=zf(),t=K(`lAmb`).value;(!yf||t!==bf)&&(yf=Bf(e.ambient.color),bf=t),_f=od.createForEntity({depthTexture:null,cfg:null,probeSource:yf.source,lightEnv:e,sampleLiftWorld:Q.worldHeight*.4}),Hf()}function Hf(){X&&(X.container.filters=K(`lightOn`).checked&&_f?[_f]:[])}function Uf(){if(X){if(K(`lightOn`).checked&&_f){let e=zf();_f.setProjectionScale(uf),_f.setWorldContainerPos(J.x,J.y),_f.setSceneSize(Math.max(1,Q.worldWidth),Math.max(1,Q.worldHeight)),_f.setEntityFootX(X.x),_f.setEntityFootY(X.y),_f.setWorldToPixel(Q.cellWidth/Q.worldWidth,Q.cellHeight/Q.worldHeight),_f.setKeyLight(e.key.color,e.key.intensity),_f.setAmbient(e.ambient.color,e.ambient.intensity),_f.setTone(e.toneEnabled?e.toneStrength:0),_f.setAO(e.ao.contact,e.ao.form)}if(vf){let e=zf();vf.update({getFootX:()=>X.x,getFootY:()=>X.y,getWorldWidth:()=>Q.worldWidth,getWorldHeight:()=>Q.worldHeight,getTexture:()=>X.getDisplayTexture(),getFacing:()=>lf,isVisible:()=>!0},e)}}}function Wf(e,t,n,r){let i=t.atlasFrames?.[e],a=i?.width||t.cellWidth,o=i?.height||t.cellHeight,s=e%t.cols,c=Math.floor(e/t.cols),l=new ut(new I({source:n.source,frame:new E(s*t.cellWidth,c*t.cellHeight,a,o)}));return l.anchor.set(.5,1),l.scale.set(t.worldWidth/a*r,t.worldHeight/o),l}function Gf(){let e=K(`onion`).checked,t=X&&Q&&ef&&e?`${rf?.id}|${$}|${X.getFrameIndex()}|${lf}|${K(`onionN`).value}`:`off`;if(t===pf||(pf=t,$d.removeChildren().forEach(e=>e.destroy({children:!0,texture:!0})),!X||!Q||!ef||!e))return;let n=Q.states[$].frames,r=n.length,i=X.getFrameIndex(),a=Math.max(1,Math.min(6,+K(`onionN`).value||2));for(let e=-a;e<=a;e++){if(e===0)continue;let t=Wf(n[((i+e)%r+r)%r],Q,ef,lf);t.alpha=.22*(1-Math.abs(e)/(a+1)),t.tint=e<0?6728447:16746598,$d.addChild(t)}}async function Kf(){tf=(await fetch(`/api/anim/index`).then(e=>e.json())).bundles||[],qf(),tp()}function qf(){Jf();let e=K(`search`).value.trim().toLowerCase(),t=K(`charList`);t.innerHTML=``;let n=tf.filter(t=>!e||t.id.toLowerCase().includes(e));K(`charCount`).textContent=`${n.length}/${tf.length}`;for(let e of n){let n=document.createElement(`div`);n.className=`char`+(rf?.id===e.id?` sel`:``)+(e.summary?.valid?``:` bad`);let r=e.summary?.valid?`${e.summary.stateCount} 状态 · ${e.summary.frameCount??`?`} 帧`:`无效 anim.json`,i=document.createElement(`div`);i.textContent=e.id;let a=document.createElement(`div`);a.className=`sub`,a.textContent=`${r}${e.atlasExists?``:` · 缺图`}`,n.append(i,a),n.onclick=()=>Xf(e),t.appendChild(n)}}function Jf(){let e=K(`candidatePreview`);if(e.replaceChildren(),!Z)return;let t=document.createElement(`h2`);t.textContent=`工作台 H 候选 · 未发布`;let n=document.createElement(`div`);n.className=`char candidate${rf?.id===Z.id?` sel`:``}${Z.summary?.valid===!1?` bad`:``}`,n.title=`${Z.folderName} · ${Z.revisionId}`;let r=document.createElement(`div`);r.textContent=Z.label;let i=document.createElement(`div`);i.className=`sub`,i.textContent=Z.summary?.valid===!1?`真实渲染器加载失败 · 未发布`:Z.summary?.valid?`${Z.summary.stateCount} 状态 · ${Z.summary.frameCount??`?`} 帧 · 未发布`:`点击后直接用 SpriteEntity 校验 · 不会发布`,n.append(r,i),n.onclick=()=>void Xf(Z),e.append(t,n)}function Yf(){window.addEventListener(`workbench-preview-candidate`,e=>{let t=e.detail;if(!t||!t.id||!t.label||!t.animUrl||!t.atlasUrl||!t.revisionId){lp(`H 候选预览参数不完整`);return}Z={id:t.id,label:t.label,folderName:t.folderName,revisionId:t.revisionId,animUrl:t.animUrl,atlasUrl:t.atlasUrl,animMtime:t.animVersion,atlasMtime:t.atlasVersion,atlasExists:!0,summary:null,isWorkbenchCandidate:!0},qf(),nf&&Xf(Z)})}async function Xf(e){if(!q){lp(`游戏真实渲染预览不可用（没有 WebGPU）`);return}let t=++ff;try{rf=e,qf();let[n,r]=await Promise.all([fetch(Yd(e.animUrl,e.animMtime)).then(e=>{if(!e.ok)throw Error(`anim.json HTTP ${e.status}`);return e.json()}),po.load(Yd(e.atlasUrl,e.atlasMtime))]);if(t!==ff)return;af=n,ef=r,Q=nd(af,ef.width,ef.height),e.isWorkbenchCandidate&&(e.summary={valid:!0,stateCount:Object.keys(Q.states).length,frameCount:Q.atlasFrames?.length},e.atlasExists=!0,qf()),X&&(J.removeChild(X.container),X.destroy()),X=new Qu,X.loadFromDef(ef,Q),X.setPixelDensityMatchActive(K(`pdm`).checked),X.x=0,X.y=0,J.addChild(X.container),vf&&vf.destroy(),vf=new qd(Qd,null),Vf(),Qf(),$f(e,ef),mf?K(`bg`).value===`scene`&&wf?(gf(Af()),kf(),hf=!1):(op(),hf=!1):hf=!0;let i=new URLSearchParams(location.search).get(`state`),a=Object.keys(Q.states);Zf(i&&a.includes(i)?i:a[0])}catch(n){t===ff&&(e.isWorkbenchCandidate&&(e.summary={valid:!1},qf()),lp(`加载失败: `+(n?.message||n)))}}function Zf(e){if(!X||!e||!Q.states[e])return;$=e,pf=``,X.playAnimation(e),X.setDirection(lf,0),ap(!0);let t=X.getFrameCount(),n=K(`timeline`);n.max=String(Math.max(0,t-1)),n.value=`0`,K(`fps`).value=String(Q.states[e].frameRate),Qf(),ep()}function Qf(){let e=K(`stateList`);if(e.innerHTML=``,!Q)return;for(let t of Object.keys(Q.states)){let n=document.createElement(`div`);n.className=`state`+(t===$?` sel`:``),n.textContent=t,n.onclick=()=>Zf(t),e.appendChild(n)}let t=K(`stateSel`);t.replaceChildren(...Object.keys(Q.states).map(e=>{let t=document.createElement(`option`);return t.value=e,t.textContent=e,t})),t.value=$}function $f(e,t){let n=Q,r=t.width<=2048&&t.height<=2048,i=n.cols*n.cellWidth===t.width&&n.rows*n.cellHeight===t.height,a=e.label||e.id,o=e.isWorkbenchCandidate?`<span class="pill under_review">工作台 H 候选 · 未发布</span>`:`<span class="pill published">已发布</span>`,s=e.isWorkbenchCandidate?`<div class="kv"><span class="k">工作区版本</span><span class="v mono">${Jd(e.revisionId)}</span></div>`:``;K(`info`).innerHTML=`
    <div class="card"><h2 style="margin:0 0 6px">${Jd(a)} ${o}</h2>
      ${s}
      <div class="kv"><span class="k">图集</span><span class="v mono">${t.width}×${t.height} <span class="pill ${r?`ok`:`no`}">${r?`≤2K`:`>2K!`}</span></span></div>
      <div class="kv"><span class="k">网格</span><span class="v mono">${n.cols}×${n.rows} <span class="pill ${i?`ok`:`no`}">${i?`匹配`:`不匹配`}</span></span></div>
      <div class="kv"><span class="k">单格 cell</span><span class="v mono">${n.cellWidth}×${n.cellHeight}</span></div>
      <div class="kv"><span class="k">总帧</span><span class="v mono">${n.atlasFrames?.length??`—`}</span></div>
      <div class="kv"><span class="k">世界尺寸</span><span class="v mono">${n.worldWidth}×${n.worldHeight}</span></div>
      <div class="kv"><span class="k">像素/世界</span><span class="v mono">${(n.cellWidth/n.worldWidth).toFixed(2)} × ${(n.cellHeight/n.worldHeight).toFixed(2)}</span></div>
      <div class="kv"><span class="k">状态数</span><span class="v mono">${Object.keys(n.states).length}</span></div>
    </div><div id="stateInfo"></div>`}function ep(){let e=document.getElementById(`stateInfo`);if(!e||!Q)return;let t=Q.states[$];if(!t)return;let n=(t.frames.length/(t.frameRate||1)).toFixed(2),r=t.frames.map((e,t)=>{let n=Q.atlasFrames?.[e];return`<tr><td>${t}</td><td class="mono">${e}</td><td class="mono">${e%Q.cols},${Math.floor(e/Q.cols)}</td><td class="mono">${n?n.contentWidth+`×`+n.contentHeight:`—`}</td></tr>`}).join(``);e.innerHTML=`<div class="card"><h2 style="margin:0 0 6px">状态 · ${Jd($)}</h2>
      <div class="kv"><span class="k">帧率</span><span class="v mono">${t.frameRate} fps</span></div>
      <div class="kv"><span class="k">循环</span><span class="v"><span class="pill ${t.loop?`ok`:`no`}">${t.loop}</span></span></div>
      <div class="kv"><span class="k">帧数</span><span class="v mono">${t.frames.length}</span></div>
      <div class="kv"><span class="k">时长</span><span class="v mono">${n}s</span></div>
      <table class="frames"><thead><tr><th>#</th><th>slot</th><th>col,row</th><th>content</th></tr></thead><tbody>${r}</tbody></table></div>`}function tp(){let e=K(`cmpChar`),t=e.value;e.replaceChildren(...tf.filter(e=>e.summary?.valid).map(e=>{let t=document.createElement(`option`);return t.value=e.id,t.textContent=e.id,t})),t&&(e.value=t)}async function np(){let e=K(`cmp`).checked;if(K(`cmpChar`).style.display=e?``:`none`,K(`cmpState`).style.display=e?``:`none`,xf&&=(J.removeChild(xf.container),xf.destroy(),null),!e){X&&(X.x=0);return}let t=K(`cmpChar`).value,n=tf.find(e=>e.id===t);if(!n)return;let r=await fetch(Yd(n.animUrl,n.animMtime)).then(e=>e.json());Sf=await po.load(Yd(n.atlasUrl,n.atlasMtime)),Cf=nd(r,Sf.width,Sf.height),xf=new Qu,xf.loadFromDef(Sf,Cf);let i=K(`cmpState`);i.replaceChildren(...Object.keys(Cf.states).map(e=>{let t=document.createElement(`option`);return t.value=e,t.textContent=e,t}));let a=Cf.states[$]?$:Object.keys(Cf.states)[0];i.value=a,xf.playAnimation(a),xf.setDirection(lf,0);let o=(Q.worldWidth+Cf.worldWidth)*.6;X&&(X.x=-o/2),xf.x=o/2,xf.y=0,J.addChild(xf.container)}function rp(){if(!ef||!Q)return;K(`atlasModal`).style.display=`block`;let e=K(`atlasCanvas`),t=ef.width,n=ef.height;e.width=t,e.height=n;let r=e.getContext(`2d`),i=ef.source.resource;try{r.drawImage(i,0,0,t,n)}catch{r.fillStyle=`#222`,r.fillRect(0,0,t,n)}r.lineWidth=1,r.strokeStyle=`rgba(80,140,255,.45)`;for(let e=0;e<=Q.cols;e++)r.beginPath(),r.moveTo(e*Q.cellWidth,0),r.lineTo(e*Q.cellWidth,n),r.stroke();for(let e=0;e<=Q.rows;e++)r.beginPath(),r.moveTo(0,e*Q.cellHeight),r.lineTo(t,e*Q.cellHeight),r.stroke();r.strokeStyle=`rgba(52,211,153,.95)`,r.lineWidth=2;for(let e of Q.states[$].frames){let t=e%Q.cols,n=Math.floor(e/Q.cols);r.strokeRect(t*Q.cellWidth+1,n*Q.cellHeight+1,Q.cellWidth-2,Q.cellHeight-2)}K(`atlasMeta`).textContent=` ${t}×${n} · 网格 ${Q.cols}×${Q.rows} · cell ${Q.cellWidth}×${Q.cellHeight} · 绿框=当前状态「${$}」`}async function ip(){if(!X||!$)return;lp(`导出 GIF 中…`);let n=of,r=X.getFrameIndex(),i=Zd.visible;try{let{GIFEncoder:n,quantize:r,applyPalette:i}=await t(async()=>{let{GIFEncoder:t,quantize:n,applyPalette:r}=await import(`./gifenc-DLhhX4iG.js`).then(t=>e(t.default,1));return{GIFEncoder:t,quantize:n,applyPalette:r}},__vite__mapDeps([2,3])),a=Q.states[$].frames,o=Q.states[$].frameRate||8;ap(!1);let s=q.renderer.width,c=q.renderer.height,l=new E(0,0,q.screen.width,q.screen.height),u=document.createElement(`canvas`);u.width=s,u.height=c;let d=u.getContext(`2d`),f=n();Zd.visible=!1;for(let e=0;e<a.length;e++){X.setFrameIndex(e),Uf(),Gf(),J.scale.set(uf);let t=await q.renderer.extract.canvas({target:q.stage,frame:l});d.clearRect(0,0,s,c),d.drawImage(t,0,0);let{data:n}=d.getImageData(0,0,s,c),a=r(n,256),u=i(n,a);f.writeFrame(u,s,c,{palette:a,delay:Math.round(1e3/o)})}f.finish();let p=new Blob([f.bytes()],{type:`image/gif`}),m=document.createElement(`a`);m.href=URL.createObjectURL(p),m.download=`${rf.id}_${$}.gif`,m.click(),URL.revokeObjectURL(m.href),lp(`GIF 已导出`)}catch(e){lp(`GIF 导出失败: ${e?.message||e}`)}finally{Zd.visible=i,X.setFrameIndex(r),pf=``,ap(n)}}function ap(e){of=e,K(`btnPlay`).textContent=e?`⏸ 暂停`:`▶ 播放`,X?.setPlaying(e)}function op(){!Q||!q||(gf(q.renderer.height*.55/Q.worldHeight),J.scale.set(uf),jf())}function sp(){K(`btnPlay`).onclick=()=>ap(!of),K(`btnLoop`).onclick=()=>{sf=!sf,K(`btnLoop`).classList.toggle(`on`,sf)},K(`btnLoop`).classList.add(`on`),K(`btnPrev`).onclick=()=>{ap(!1),X?.setFrameIndex(X.getFrameIndex()-1)},K(`btnNext`).onclick=()=>{ap(!1),X?.setFrameIndex(X.getFrameIndex()+1)},K(`btnFacing`).onclick=()=>{lf=lf===1?-1:1,X?.setDirection(lf,0),xf?.setDirection(lf,0)},K(`btnFit`).onclick=()=>op();let e=K(`timeline`);e.oninput=()=>{df=!0,ap(!1),X?.setFrameIndex(parseInt(e.value))},e.onchange=()=>{df=!1};let t=K(`speed`);t.oninput=()=>{cf=parseFloat(t.value),K(`speedV`).textContent=cf.toFixed(1)+`×`},K(`fps`).onchange=e=>{Q&&$&&(Q.states[$].frameRate=Math.max(1,parseInt(e.target.value)||8)),ep()};let n=K(`zoom`);n.oninput=()=>{uf=parseFloat(n.value),J.scale.set(uf),jf()},K(`stateSel`).onchange=e=>Zf(e.target.value);let r=K(`bg`),i=K(`sceneBg`);r.onchange=()=>{i.style.display=r.value===`scene`?``:`none`,r.value===`scene`&&Tf.length?Nf(Tf[parseInt(i.value)||0]):(wf=null,kf())},i.onchange=()=>Nf(Tf[parseInt(i.value)||0]),K(`pdm`).onchange=e=>X?.setPixelDensityMatchActive(e.target.checked),K(`search`).oninput=()=>qf(),K(`lightOn`).onchange=()=>Hf(),K(`lAmb`).onchange=()=>Vf(),K(`btnAtlas`).onclick=()=>rp(),K(`atlasClose`).onclick=()=>{K(`atlasModal`).style.display=`none`},K(`btnLight`).onclick=()=>{K(`lightModal`).style.display=`flex`},K(`lightClose`).onclick=()=>{K(`lightModal`).style.display=`none`},K(`lightModal`).onclick=e=>{e.target===K(`lightModal`)&&(K(`lightModal`).style.display=`none`)},K(`btnGif`).onclick=()=>ip(),K(`cmp`).onchange=()=>np(),K(`cmpChar`).onchange=()=>np(),K(`cmpState`).onchange=()=>{let e=K(`cmpState`).value;xf?.playAnimation(e)},window.addEventListener(`workbench-page-change`,e=>{let t=e.detail?.pageId;Of(t===`previewPage`)}),window.addEventListener(`keydown`,e=>{if(!document.getElementById(`previewPage`)?.classList.contains(`active`))return;let t=e.target instanceof HTMLElement?e.target:null;t&&(t.matches(`input,select,textarea,button`)||t.isContentEditable||t.closest(`[contenteditable="true"]`))||(e.key===` `?(e.preventDefault(),ap(!of)):e.key===`ArrowLeft`?(ap(!1),X?.setFrameIndex(X.getFrameIndex()-1)):e.key===`ArrowRight`&&(ap(!1),X?.setFrameIndex(X.getFrameIndex()+1)))})}var cp;function lp(e){let t=K(`toast`);t.textContent=e,t.classList.add(`show`),clearTimeout(cp),cp=setTimeout(()=>t.classList.remove(`show`),2200)}async function up(){if(!await Ef())return;if(sp(),await Kf(),await Pf(),nf=!0,Z){await Xf(Z);return}let e=new URLSearchParams(location.search).get(`char`),t=tf.find(t=>t.id===e)||tf.find(e=>e.summary?.valid);t&&await Xf(t)}Yf(),up();