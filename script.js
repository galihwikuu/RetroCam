const video = document.getElementById('video');
video.setAttribute("playsinline","");
video.setAttribute("muted","");
video.setAttribute("autoplay","");

const grab = document.getElementById('grab');
const gctx = grab.getContext('2d', { willReadFrequently: true });

const out = document.getElementById('out');
const octx = out.getContext("2d", {
    alpha: false,
    willReadFrequently: true
});
octx.imageSmoothingEnabled = true;
gctx.imageSmoothingEnabled = true;

// deteksi gerakan buat efek shake
const motionCanvas = document.createElement('canvas');
motionCanvas.width = 20;
motionCanvas.height = 27;
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
let prevMotionData = null;
let motionLevel = 0; // 0 = diam, mendekati 1 = gerak kencang

const caption = document.getElementById('caption');
const flashEl = document.getElementById('flash');
const btnShake = document.getElementById('btnShake');
const btnDither = document.getElementById('btnDither');
const btnTone = document.getElementById('btnTone');
const btnMode = document.getElementById('btnMode');
const btnShot = document.getElementById('btnShot');
const recIndicator = document.getElementById('recIndicator');
const recTimeEl = document.getElementById('recTime');
const hintEl = document.getElementById('hint');

const W = 480;
const H = 640;
let stream = null;
let currentFacing = "environment";
let retroColor = false;
let tone = 'color'; // color | green | gray
let live = true;
let frozenFrame = null;
let rafId = null;
let mode = 'photo'; // photo | video
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;
let recordTimerInterval = null;
let recordStartTime = 0;
let mimeType="";
let previewMode = false;
let previewVideo = null;
let previewImage = null;
let lastVideoBlob = null;
let audioContext = null;
let audioDestination = null;
let micStream = null;
let lastPhotoURL = null;
let noiseOn = false;
let shakeOn = false; // bisa di-toggle kalau mau
let shakeX = 0;
let shakeY = 0;

console.log(out.width,out.height);
console.log(out.clientWidth,out.clientHeight);

// palette: nokia LCD green shades (dark -> light), 4 levels
const palettes = {
green: ['#12200c', '#2f5420', '#6c9b47', '#c7e8a0'],
gray:  ['#0c0c0c', '#4a4a4a', '#9a9a9a', '#e8e8e8']
};

// 2006-era phone camera color grading: crushed shadows, soft contrast,
// slight warm/green cast, muted saturation, low res softness
function gradeColor(r,g,b){

    const lum=0.299*r+0.587*g+0.114*b;

    if(retroColor){

        // HP China 0.3 MP

        const sat=0.68;

        r=lum+(r-lum)*sat;
        g=lum+(g-lum)*sat;
        b=lum+(b-lum)*sat;

        r*=0.98;
        g*=1.04;
        b*=0.88;

        const contrast=0.88;

        r=((r-128)*contrast)+128;
        g=((g-128)*contrast)+128;
        b=((b-128)*contrast)+128;

        r-=5;
        g-=2;
        b-=8;

    }else{

        // Natural

        const sat=0.95;

        r=lum+(r-lum)*sat;
        g=lum+(g-lum)*sat;
        b=lum+(b-lum)*sat;

    }

    return[
        Math.max(0,Math.min(255,r)),
        Math.max(0,Math.min(255,g)),
        Math.max(0,Math.min(255,b))
    ];

}

function hexToRgb(hex){
const v = parseInt(hex.slice(1), 16);
return [ (v>>16)&255, (v>>8)&255, v&255 ];
}

function updateClock(){
const d = new Date();
document.getElementById('clock').textContent =
    String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
setInterval(updateClock, 1000*10);
updateClock();


async function startCamera() {

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }

    const constraints = {
        video: {
            facingMode: { ideal: currentFacing },
            width: { ideal: 240 },
            height: { ideal: 320 },
            frameRate: { ideal: 10, max: 10 }
        },
        audio: false
    };

    try {

        stream = await navigator.mediaDevices.getUserMedia(constraints);

        video.srcObject = stream;

        await video.play();
        console.log(stream.getVideoTracks()[0].getSettings());

        console.log({
            video: video.videoWidth + "x" + video.videoHeight,
            outCanvas: out.width + "x" + out.height,
            outCss: out.clientWidth + "x" + out.clientHeight,
            dpr: window.devicePixelRatio
        });

        await new Promise(resolve => {
            if (video.readyState >= 2) {
                resolve();
            } else {
                video.onloadedmetadata = resolve;
            }
        });

        console.log("Video :", video.videoWidth, video.videoHeight);
        console.log("Grab  :", grab.width, grab.height);
        console.log("Out   :", out.width, out.height);

        caption.textContent = "SIAP MEMOTRET";

    } catch (e) {

        console.error(e);
        caption.textContent = "KAMERA GAGAL DIAKSES";

    }

}

function applyNoise(data, density){
    if(!noiseOn) return;
    for(let i = 0; i < data.length; i += 4){
        if(Math.random() < density){
            const dark = Math.random() * 15;
            data[i]   = dark;
            data[i+1] = dark;
            data[i+2] = dark;
        }
    }
}

function detectMotion(){
    if(video.readyState < 2) return 0;

    motionCtx.drawImage(video, 0, 0, motionCanvas.width, motionCanvas.height);
    const frame = motionCtx.getImageData(0, 0, motionCanvas.width, motionCanvas.height).data;

    if(!prevMotionData){
        prevMotionData = new Uint8ClampedArray(frame);
        return 0;
    }

    let diffSum = 0;
    for(let i = 0; i < frame.length; i += 4){
        diffSum += Math.abs(frame[i] - prevMotionData[i]);
    }
    prevMotionData.set(frame);

    return diffSum / (frame.length / 4); // rata-rata perbedaan tiap pixel (0-255)
}

function updateShake(motion){
    if(!shakeOn){
        shakeX = 0;
        shakeY = 0;
        motionLevel = 0;
        return;
    }

    const threshold = 0.3;   // makin sensitif ke gerakan kecil
    const maxDiff = 8;       // lebih gampang "penuh" jadi motionLevel cepat maksimal

    let m = Math.max(0, motion - threshold) / (maxDiff - threshold);
    m = Math.min(1, m);

    if(m > motionLevel){
        motionLevel = m;
    }else{
        motionLevel *= 0.93;  // decay lebih lambat, shake bertahan lebih lama
    }

    const amplitude = motionLevel * 9;   // ← paling kerasa, dari 5 ke 9

    shakeX += (Math.random() - 0.5) * amplitude;
    shakeY += (Math.random() - 0.5) * amplitude;

    shakeX *= 0.85;   // sedikit lebih "liar", damping dikurangin dari 0.8
    shakeY *= 0.85;

    shakeX = Math.max(-10, Math.min(10, shakeX));   // ← naikin dari 6 ke 10
    shakeY = Math.max(-10, Math.min(10, shakeY));
}

function renderFrame(){

    if(video.readyState < 2) return;
    if(!video.videoWidth) return;

    // efek frame drop hanya saat rekam video
    if(recording && Math.random() < 0.25){
        return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const targetRatio = W / H;
    const srcRatio = vw / vh;

    let sx, sy, sw, sh;

    if(srcRatio > targetRatio){

        sh = vh;
        sw = vh * targetRatio;
        sx = (vw - sw) / 2;
        sy = 0;

    }else{

        sw = vw;
        sh = vw / targetRatio;
        sx = 0;
        sy = (vh - sh) / 2;

    }

    const track = stream.getVideoTracks()[0];
    const facing = track.getSettings().facingMode;

    const motion = detectMotion();
        updateShake(motion);

        gctx.save();

    // MIRROR KAMERA DEPAN
    if(facing === "user"){
        gctx.translate(W,0);
        gctx.scale(-1,1);
    }

    gctx.drawImage(
        video,
        sx,
        sy,
        sw,
        sh,
        shakeX,      // ← ganti dari 0
        shakeY,      // ← ganti dari 0
        W,
        H
    );

    gctx.restore();

    gctx.save();
    
    // MIRROR KAMERA DEPAN
    if(facing === "user"){
        gctx.translate(W,0);
        gctx.scale(-1,1);
    }

    
    gctx.drawImage(
        video, sx, sy, sw, sh,
        shakeX - 10,
        shakeY - 10,
        W + 20,
        H + 20
    );

    gctx.restore();

    const imgData = gctx.getImageData(0,0,W,H);
    const data = imgData.data;

    if(tone === "color"){

        for(let i=0;i<data.length;i+=4){

            const rgb = gradeColor(
                data[i],
                data[i+1],
                data[i+2]
            );

            data[i]   = rgb[0];
            data[i+1] = rgb[1];
            data[i+2] = rgb[2];
            data[i+3] = 255;
        }

    }else{

        const levels = palettes[tone];
        const levelRgb = levels.map(hexToRgb);

        for(let y=0;y<H;y++){

            for(let x=0;x<W;x++){

                const idx=(y*W+x)*4;

                const lum=
                    (
                        0.299*data[idx]+
                        0.587*data[idx+1]+
                        0.114*data[idx+2]
                    )/255;

                let level;

                if(retroColor){

                    const t=bayer4[y%4][x%4];

                    level=Math.floor(lum*4+(t-0.5));

                    level=Math.max(0,Math.min(3,level));

                }else{

                    level=Math.floor(lum*4);

                    level=Math.max(0,Math.min(3,level));

                }

                const c=levelRgb[level];

                data[idx]=c[0];
                data[idx+1]=c[1];
                data[idx+2]=c[2];
                data[idx+3]=255;
            }

        }

    }


    applyNoise(data, 0.0015);

    gctx.putImageData(imgData,0,0);

    gctx.putImageData(imgData,0,0);


    // tampilkan ke layar
    octx.imageSmoothingEnabled = true;

    octx.setTransform(1, 0, 0, 1, 0, 0);

    octx.clearRect(0,0,W,H);

    octx.drawImage(
        grab,
        0, 0,
        W, H
    );


}

function loop(time){

    if(previewMode){

        if(mode==="photo"){

            octx.clearRect(0,0,W,H);
            octx.drawImage(previewImage,0,0,W,H);

        }else if(mode==="video"){

            octx.clearRect(0,0,W,H);
            octx.drawImage(previewVideo,0,0,W,H);

        }

    }else{

        renderFrame();

    }

    rafId = requestAnimationFrame(loop);

}
function formatTime(ms){
const s = Math.floor(ms / 1000);
const mm = String(Math.floor(s / 60)).padStart(2, '0');
const ss = String(s % 60).padStart(2, '0');
return mm + ':' + ss;
}

function takePhoto(){

    if(!video.videoWidth) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const targetRatio = W / H;
    const srcRatio = vw / vh;

    let sx, sy, sw, sh;

    if(srcRatio > targetRatio){

        sh = vh;
        sw = vh * targetRatio;
        sx = (vw - sw) / 2;
        sy = 0;

    }else{

        sw = vw;
        sh = vw / targetRatio;
        sx = 0;
        sy = (vh - sh) / 2;

    }

    const saveCanvas = document.createElement("canvas");

    saveCanvas.width = W;
    saveCanvas.height = H;

    const sctx = saveCanvas.getContext("2d",{
        willReadFrequently:true
    });

    // mirror jika kamera depan
    const facing = stream.getVideoTracks()[0].getSettings().facingMode;

    sctx.save();

    if(facing==="user"){
        sctx.translate(saveCanvas.width,0);
        sctx.scale(-1,1);
    }

    sctx.drawImage(
        video,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        W,
        H
    );

    sctx.restore();

    // Terapkan gradeColor agar sama seperti preview
    const img = sctx.getImageData(
        0,
        0,
        saveCanvas.width,
        saveCanvas.height
    );

    const data = img.data;

    for(let i=0;i<data.length;i+=4){

        const rgb = gradeColor(
            data[i],
            data[i+1],
            data[i+2]
        );

        data[i]   = rgb[0];
        data[i+1] = rgb[1];
        data[i+2] = rgb[2];

    }

    for(let i=0;i<data.length;i+=4){
        const rgb = gradeColor(data[i], data[i+1], data[i+2]);
        data[i]   = rgb[0];
        data[i+1] = rgb[1];
        data[i+2] = rgb[2];
    }

    applyNoise(data, 0.004);   // ← tambahan

    sctx.putImageData(img,0,0);

    sctx.putImageData(img,0,0);

    lastPhotoURL = saveCanvas.toDataURL(
        "image/jpeg",
        0.35
    );

    previewImage = new Image();

    previewImage.onload = ()=>{

        previewMode = true;
        live = false;

    };

    previewImage.src = lastPhotoURL;

    flashEl.classList.remove("go");
    void flashEl.offsetWidth;
    flashEl.classList.add("go");

    caption.textContent = "FOTO DIAMBIL — TEKAN SIMPAN";

}
function getBestMimeType() {

    const types = [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
    ];

    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }

    return "";
}

async function startRecording() {

    if (recording) return;

    if (!out) {
        alert("Canvas tidak ditemukan.");
        return;
    }

    // Pastikan ada frame pada canvas
    renderFrame();

    recordedChunks = [];
    lastVideoBlob = null;

    // Video dari canvas
    const canvasStream = out.captureStream(15);

    // Audio dari mikrofon
    micStream = null;

    try {

        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        audioContext = new AudioContext();

        const source = audioContext.createMediaStreamSource(micStream);

        // Filter suara HP jadul
        const bandpass = audioContext.createBiquadFilter();
        bandpass.type = "bandpass";
        bandpass.frequency.value = 700;
        bandpass.Q.value = 0.7;

        // Gain
        const gain = audioContext.createGain();
        gain.gain.value = 6;

        // Distorsi ringan
        const wave = audioContext.createWaveShaper();

        const curve = new Float32Array(65536);

        for(let i=0;i<65536;i++){

            let x=i/32768-1;

            curve[i]=Math.tanh(x*20);

        }

        wave.curve = curve;
        wave.oversample = "4x";

        audioDestination =
            audioContext.createMediaStreamDestination();

        source.connect(bandpass);
        bandpass.connect(wave);
        wave.connect(gain);
        gain.connect(audioDestination);

    } catch(err){

        console.warn(err);

    }

    // Gabungkan video + audio
    const mixedStream = new MediaStream();

    canvasStream.getVideoTracks().forEach(track => {
        mixedStream.addTrack(track);
    });

    if (audioDestination) {

        audioDestination.stream
            .getAudioTracks()
            .forEach(track => {

                mixedStream.addTrack(track);

            });

    }

    // Cari format terbaik
    mimeType = getBestMimeType();

    const options = {

        videoBitsPerSecond:180000,

        audioBitsPerSecond:8000

    };

    if (mimeType) {
        options.mimeType = mimeType;
    }

    try {

        mediaRecorder = new MediaRecorder(mixedStream, options);

    } catch (err) {

        console.warn("Mime type tidak didukung, memakai default.");

        mediaRecorder = new MediaRecorder(mixedStream);

        mimeType = mediaRecorder.mimeType || "video/webm";

    }

    mediaRecorder.ondataavailable = (event) => {

        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }

    };

    mediaRecorder.onstop = () => {

        lastVideoBlob = new Blob(recordedChunks, {
            type: mimeType || "video/webm"
        });
        previewVideo = document.createElement("video");

        previewVideo.muted = false;

        previewVideo.controls = false;

        previewVideo.loop = true;

        previewVideo.playsInline = true;

        previewVideo.src = URL.createObjectURL(lastVideoBlob);

        previewVideo.onloadeddata = () => {

            previewMode = true;

            live = false;

            previewVideo.play();

        };

        console.log("Recording selesai");
        console.log("MimeType :", mimeType);
        console.log("Ukuran :", lastVideoBlob.size);

    };

    mediaRecorder.onerror = (err) => {
        console.error(err);
    };

    mediaRecorder.start();

    recording = true;

    recordStartTime = Date.now();

    recIndicator.classList.add("on");

    btnShot.classList.add("recording");

    btnShot.textContent = "STOP";

    recTimeEl.textContent = "00:00";

    recordTimerInterval = setInterval(() => {

        recTimeEl.textContent =
            formatTime(Date.now() - recordStartTime);

    }, 200);

    caption.textContent = mimeType.includes("mp4")
        ? "SEDANG MEREKAM"
        : "SEDANG MEREKAM";

}

function stopRecording() {

    if (!recording) return;

    recording = false;

    // Stop recorder
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }

    // Stop microphone
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
        if(audioContext){
            audioContext.close();
            audioContext = null;
            audioDestination = null;
        }
    }

    // Stop timer
    clearInterval(recordTimerInterval);
    recordTimerInterval = null;

    // Reset UI
    recIndicator.classList.remove("on");
    btnShot.classList.remove("recording");
    btnShot.textContent = "REC";

    recTimeEl.textContent = "00:00";

    caption.textContent = "VIDEO BERHASIL DIREKAM";

    console.log("Recording stopped");

}

btnShot.addEventListener('click', () => {
if (mode === 'photo'){
    takePhoto();
} else {
    if (!recording) startRecording(); else stopRecording();
}
});

async function shareOrDownload(blob, filename, mimeType){

    const file = new File([blob], filename, { type: mimeType });

    // Coba pakai Web Share API dulu (native share sheet -> bisa "Save to Photos")
    if (navigator.canShare && navigator.canShare({ files: [file] })) {

        try {
            await navigator.share({
                files: [file],
                title: "NokiaCam by -galihwikuu"
            });
            return true; // berhasil dibagikan/disimpan lewat share sheet
        } catch (err) {
            // user cancel share sheet, atau error -> lanjut fallback download
            if (err.name === "AbortError") return false;
            console.warn("Share gagal, fallback ke download:", err);
        }
    }

    // Fallback: cara lama, download biasa
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = filename;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
}

document.getElementById("btnSave").addEventListener("click", async () => {

    if (mode === "photo") {

        if (!lastPhotoURL) {
            caption.textContent = "BELUM ADA FOTO";
            return;
        }

        // ubah dataURL jadi blob
        const res = await fetch(lastPhotoURL);
        const blob = await res.blob();

        await shareOrDownload(blob, "nokiacam_photo_" + Date.now() + ".jpg", "image/jpeg");

        previewMode = false;
        renderFrame();
        live = true;
        previewImage = null;

        if (previewVideo) {
            previewVideo.pause();
            URL.revokeObjectURL(previewVideo.src);
            previewVideo = null;
        }

        caption.textContent = "FOTO TERSIMPAN";

    } else {

        if (!lastVideoBlob) {
            caption.textContent = "BELUM ADA VIDEO";
            return;
        }

        const ext = mimeType.includes("mp4") ? "mp4" : "webm";
        const vType = mimeType.includes("mp4") ? "video/mp4" : "video/webm";

        await shareOrDownload(lastVideoBlob, "nokiacam_video_" + Date.now() + "." + ext, vType);

        caption.textContent = "VIDEO TERSIMPAN";

    }

});

btnMode.addEventListener('click', () => {

    if (recording) return;

    mode = mode === "photo" ? "video" : "photo";

    // Reset hasil sebelumnya
    lastPhotoURL = null;
    lastVideoBlob = null;
    frozenFrame = null;

    live = true;

    btnMode.textContent =
        mode === "photo" ? "MODE: FOTO" : "MODE: VIDEO";

    btnShot.textContent =
        mode === "photo" ? "JEPRET" : "REC";

    caption.textContent =
        mode === "photo"
            ? "SIAP MEMOTRET"
            : "SIAP MEREKAM";


});

btnShake.addEventListener("click", () => {
    shakeOn = !shakeOn;
    btnShake.textContent = "GOYANG: " + (shakeOn ? "ON" : "OFF");
});

btnDither.addEventListener("click",()=>{

    retroColor=!retroColor;

    btnDither.textContent=
        "RETRO: "+(retroColor?"ON":"OFF");

});

const toneOrder = ['color', 'green', 'gray'];
const toneLabel = { color: 'WARNA', green: 'HIJAU', gray: 'ABU-ABU' };
btnTone.addEventListener('click', () => {
    noiseOn = !noiseOn;
    btnTone.textContent = "NOISE: " + (noiseOn ? "ON" : "OFF");
});

document.getElementById("btnSwitch").addEventListener("click", async () => {

    currentFacing =
        currentFacing === "environment"
            ? "user"
            : "environment";

    await startCamera();

});


document.addEventListener("visibilitychange", async () => {

    if (document.hidden) {

        cancelAnimationFrame(rafId);
        return;

    }

    if (
        !stream ||
        stream.getVideoTracks().length === 0 ||
        stream.getVideoTracks()[0].readyState !== "live"
    ) {

        await startCamera();

    }

    rafId = requestAnimationFrame(loop);

});

document.getElementById("btnRetry").onclick=()=>{

    previewMode=false;

    live=true;

    previewImage=null;

    if(previewVideo){

        previewVideo.pause();

        URL.revokeObjectURL(previewVideo.src);

        previewVideo=null;

    }

    lastPhotoURL=null;

    lastVideoBlob=null;

    caption.textContent=
        mode==="photo"
        ?"SIAP MEMOTRET"
        :"SIAP MEREKAM";

}

(function initIntro(){
    const overlay = document.getElementById('introOverlay');
    const closeBtn = document.getElementById('introClose');

    closeBtn.addEventListener('click', () => {
        overlay.classList.add('hidden');
    });
})();


(async function init(){
    btnTone.textContent = "NOISE: OFF";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        caption.textContent = 'BROWSER TIDAK DIDUKUNG';
        return;
    }
    await startCamera(null);
    rafId=requestAnimationFrame(loop);
    })();

    if ("serviceWorker" in navigator) {

        window.addEventListener("load", () => {

            navigator.serviceWorker.register("sw.js")

            .then(() => {

                console.log("PWA aktif");

            });

        });

    }

    function fitPhoneToScreen(){
    const phone = document.querySelector('.phone');
    const wrap = document.querySelector('.phone-wrap');
    if(!phone || !wrap) return;

    // reset dulu biar ukuran asli kebaca
    phone.style.transform = 'scale(1)';

    const phoneRect = phone.getBoundingClientRect();
    const availW = wrap.clientWidth - 16;  // sisain sedikit margin kiri-kanan
    const availH = wrap.clientHeight - 16; // sisain sedikit margin atas-bawah

    const scale = Math.min(
        1,
        availW / phoneRect.width,
        availH / phoneRect.height
    );

    phone.style.transform = `scale(${scale})`;
}

window.addEventListener('resize', fitPhoneToScreen);
window.addEventListener('orientationchange', fitPhoneToScreen);
window.addEventListener('load', fitPhoneToScreen);

// panggil juga langsung, kalau script dimuat setelah DOM siap
fitPhoneToScreen();