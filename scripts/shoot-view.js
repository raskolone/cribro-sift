const path=require("path"),puppeteer=require("puppeteer-core");
const CHROME="/Users/maciej/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
(async()=>{
 const [view,label]=process.argv.slice(2);
 const b=await puppeteer.launch({executablePath:CHROME,headless:"shell",args:["--no-sandbox","--force-color-profile=srgb"]});
 const p=await b.newPage();
 await p.setViewport({width:1280,height:900,deviceScaleFactor:2});
 const errs=[]; p.on("pageerror",e=>errs.push(e.message));
 await p.goto("file://"+path.join(process.cwd(),"src/renderer/index.html"),{waitUntil:"networkidle0"});
 await p.evaluate(()=>document.fonts.ready);
 await new Promise(r=>setTimeout(r,900));
 if(view!=="sifted"){ await p.click(`.nav__item[data-view="${view}"]`); await new Promise(r=>setTimeout(r,700)); }
 await p.screenshot({path:`.shots/app-${label}.png`});
 await b.close();
 console.log("→ .shots/app-"+label+".png", errs.length?("BŁĘDY: "+errs.join("|")):"czysto");
})();
