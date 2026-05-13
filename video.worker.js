import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { chromium } from "playwright";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

const OWNER = "milad-jfr";
const REPO = "remote-browser";
const BRANCH = "main";

const MAX_CHUNK = 90 * 1024 * 1024;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function rawUrl(file) {
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/result/${file}`;
}

function detectStreamType(url) {

  if (!url) return null;

  const u = url.toLowerCase();

  if (u.includes(".m3u8")) return "hls";
  if (u.includes(".mpd")) return "dash";
  if (u.includes(".mp4")) return "mp4";
  if (u.startsWith("blob:")) return "blob";

  return "unknown";
}

function isYoutube(url) {
  return url && (
    url.includes("youtube.com") ||
    url.includes("youtu.be")
  );
}

function isPornhub(url) {
  return url && url.includes("pornhub.com");
}

function uniqueVideos(videos) {

  const map = new Map();

  for (const v of videos) {
    if (!v?.url) continue;
    if (!map.has(v.url)) {
      map.set(v.url, v);
    }
  }

  return [...map.values()];
}

function is240(q) {

  if (!q) return false;

  q = String(q).toLowerCase();

  return (
    q.includes("240") ||
    q.includes("426x240") ||
    q === "small"
  );
}

function pickBest240(videos) {

  const q240 = videos.find(v => is240(v.quality));

  if (q240) return q240;

  // fallback lowest bitrate
  return videos.sort((a,b)=> (a.bitrate||0)-(b.bitrate||0))[0];
}

async function safeGoto(page,url){

  try{

    await page.goto(url,{
      waitUntil:"domcontentloaded",
      timeout:90000
    });

  }catch{

    await page.goto(url,{
      waitUntil:"load",
      timeout:90000
    });

  }

}

async function extractYoutube(page){

  return await page.evaluate(()=>{

    const player = window.ytInitialPlayerResponse;

    if(!player) return null;

    const streams = [
      ...(player.streamingData?.formats||[]),
      ...(player.streamingData?.adaptiveFormats||[])
    ];

    const formats=[];

    for(const s of streams){

      let url = s.url;

      if(!url && s.signatureCipher){

        const p=new URLSearchParams(s.signatureCipher);
        url=p.get("url");

      }

      if(!url) continue;

      formats.push({

        url,
        quality:s.qualityLabel||s.quality,
        mimeType:s.mimeType,
        bitrate:s.bitrate,
        hasAudio:!!s.audioQuality,
        hasVideo:!!s.qualityLabel

      });

    }

    return {
      title:player.videoDetails?.title,
      formats
    };

  });

}

async function extractPornhub(page){

  return await page.evaluate(()=>{

    const result={
      title:document.title,
      formats:[]
    };

    const scripts=[...document.querySelectorAll("script")];

    for(const s of scripts){

      const t=s.innerText;

      const m=t.match(/"mediaDefinitions":(\[[\s\S]*?\])/);

      if(!m) continue;

      try{

        const defs=JSON.parse(m[1]);

        for(const d of defs){

          if(!d.videoUrl) continue;

          result.formats.push({
            url:d.videoUrl,
            quality:d.quality
          });

        }

      }catch{}

    }

    return result;

  });

}

async function extractGenericVideos(page){

  return await page.evaluate(()=>{

    const results=[];
    const vids=[...document.querySelectorAll("video")];

    for(const v of vids){

      if(v.currentSrc && !v.currentSrc.startsWith("blob:"))
        results.push({url:v.currentSrc});

      if(v.src && !v.src.startsWith("blob:"))
        results.push({url:v.src});

      for(const s of v.querySelectorAll("source")){
        if(s.src) results.push({url:s.src});
      }

    }

    return results;

  });

}

function downloadWithFFmpeg(url,output){

  try{

    execSync(
      `ffmpeg -y -loglevel error -i "${url}" -c copy "${output}"`
    );

  }catch{

    execSync(
      `ffmpeg -y -loglevel error -i "${url}" -c:v libx264 -c:a aac "${output}"`
    );

  }

}

function chunkIfNeeded(file,id){

  const size=fs.statSync(file).size;

  if(size<=MAX_CHUNK){
    return [file];
  }

  const outPattern=`${RESULT_DIR}/${id}_part_%03d.mp4`;

  execSync(
    `ffmpeg -i "${file}" -c copy -map 0 -f segment -segment_time 300 -reset_timestamps 1 "${outPattern}"`
  );

  fs.unlinkSync(file);

  const files=fs.readdirSync(RESULT_DIR)
  .filter(f=>f.startsWith(`${id}_part_`));

  return files.map(f=>path.join(RESULT_DIR,f));

}

async function processRequest(fileName){

  const requestPath=path.join(REQUEST_DIR,fileName);
  const request=JSON.parse(fs.readFileSync(requestPath));

  const id=path.parse(fileName).name;

  const browser=await chromium.launch({
    headless:true,
    args:["--no-sandbox"]
  });

  const page=await browser.newPage();

  const mediaRequests=[];

  page.on("request",req=>{

    const u=req.url().toLowerCase();

    if(
      u.includes(".mp4")||
      u.includes(".m3u8")||
      u.includes(".mpd")
    ){
      mediaRequests.push(u);
    }

  });

  await safeGoto(page,request.url);

  await sleep(6000);

  const resultVideos=[];

  let extracted=null;

  const currentUrl=page.url();

  if(isYoutube(currentUrl)){
    extracted=await extractYoutube(page);
  }
  else if(isPornhub(currentUrl)){
    extracted=await extractPornhub(page);
  }

  if(extracted?.formats){

    for(const f of extracted.formats){

      resultVideos.push({
        url:f.url,
        quality:f.quality,
        bitrate:f.bitrate,
        streamType:detectStreamType(f.url)
      });

    }

  }

  const generic=await extractGenericVideos(page);

  for(const g of generic){

    resultVideos.push({
      url:g.url,
      quality:null,
      streamType:detectStreamType(g.url)
    });

  }

  for(const r of mediaRequests){

    resultVideos.push({
      url:r,
      quality:null,
      streamType:detectStreamType(r)
    });

  }

  await browser.close();

  const videos=uniqueVideos(resultVideos);

  if(!videos.length){

    fs.writeFileSync(
      `${RESULT_DIR}/${id}.video.json`,
      JSON.stringify({error:"no video found"},null,2)
    );

    return;

  }

  const chosen=pickBest240(videos);

  const output=`${RESULT_DIR}/${id}.mp4`;

  console.log("Downloading:",chosen.url);

  downloadWithFFmpeg(chosen.url,output);

  const parts=chunkIfNeeded(output,id);

  const links=parts.map(p=>rawUrl(path.basename(p)));

  fs.writeFileSync(

    `${RESULT_DIR}/${id}.video.json`,

    JSON.stringify({

      source:chosen.url,
      chunked:parts.length>1,
      chunks:links

    },null,2)

  );

}

async function main(){

  const fileName=process.argv[2];

  if(!fileName){

    console.error("no request file");
    process.exit(1);

  }

  await processRequest(fileName);

}

main();
