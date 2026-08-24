const path=require("path"),puppeteer=require("puppeteer-core");
const CHROME="/Users/maciej/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
(async()=>{
 const [file,label,w,h,bg]=process.argv.slice(2);
 const b=await puppeteer.launch({executablePath:CHROME,headless:"shell",args:["--no-sandbox","--force-color-profile=srgb"]});
 const p=await b.newPage();
 await p.setViewport({width:Number(w),height:Number(h),deviceScaleFactor:2});
 const errs=[]; p.on("pageerror",e=>errs.push(e.message));
 p.on("console",m=>{if(m.type()==="error")errs.push("konsola: "+m.text())});
 await p.goto("file://"+path.join(process.cwd(),"src/renderer/",file),{waitUntil:"networkidle0"});
 await p.evaluate(()=>document.fonts.ready);
 await new Promise(r=>setTimeout(r,1200));
 await p.screenshot({path:`.shots/${label}.png`, omitBackground: bg==="t"});
 await b.close();
 console.log(`→ .shots/${label}.png`, errs.length?("BŁĘDY: "+errs.join(" | ")):"czysto");
})();
