import { useState } from "react";
import { createRoot } from "react-dom/client";
import Fractal from "./examples/raymarched-fractal";
import BlackHole from "./examples/black-hole";
import SolarSystem from "./solar";
import Palace from "./palace";
import Macbook from "./macbook";

type PageId = "fractal" | "blackhole" | "solar" | "palace" | "macbook" | "headless";

function App() {
  const [page, setPage] = useState<PageId>(() => {
    const h = location.hash.slice(1) as PageId;
    return ["fractal", "blackhole", "solar", "palace", "macbook", "headless"].includes(h) ? h : "fractal";
  });
  const go = (p: PageId) => { setPage(p); location.hash = p; };
  return (
    <>
      <nav>
        <button className={page === "fractal" ? "active" : ""} onClick={() => go("fractal")}>Raymarched fractal</button>
        <button className={page === "blackhole" ? "active" : ""} onClick={() => go("blackhole")}>Black hole</button>
        <button className={page === "solar" ? "active" : ""} onClick={() => go("solar")}>Solar system</button>
        <button className={page === "palace" ? "active" : ""} onClick={() => go("palace")}>紫禁城 Palace</button>
        <button className={page === "macbook" ? "active" : ""} onClick={() => go("macbook")}>MacBook 拆解</button>
        <button className={page === "headless" ? "active" : ""} onClick={() => go("headless")}>Headless Node render</button>
      </nav>
      <div className="page">
        {page === "fractal" && <Fractal />}
        {page === "blackhole" && <BlackHole />}
        {page === "solar" && <SolarSystem />}
        {page === "palace" && <Palace />}
        {page === "macbook" && <Macbook />}
        {page === "headless" && (
          <div className="video-page">
            <video src="/plasma.mp4" controls autoPlay loop muted playsInline />
            <p>
              這支影片不是瀏覽器算的 —— 是 <code>vgpu/node</code> 在純 Node 裡走 Dawn/Metal
              無頭算圖（150 格 480×270），讀回像素後用 ffmpeg 編成 MP4。
              同一套 effect/target API，瀏覽器與 Node 共用。
              「Solar system」分頁的場景也是先用這條管線無頭驗證像素，才接上瀏覽器。
            </p>
          </div>
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
