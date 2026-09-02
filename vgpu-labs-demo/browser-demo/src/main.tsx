import { useState } from "react";
import { createRoot } from "react-dom/client";
import Fractal from "./examples/raymarched-fractal";
import BlackHole from "./examples/black-hole";

type PageId = "fractal" | "blackhole" | "headless";

function App() {
  const [page, setPage] = useState<PageId>("fractal");
  return (
    <>
      <nav>
        <button className={page === "fractal" ? "active" : ""} onClick={() => setPage("fractal")}>Raymarched fractal</button>
        <button className={page === "blackhole" ? "active" : ""} onClick={() => setPage("blackhole")}>Black hole</button>
        <button className={page === "headless" ? "active" : ""} onClick={() => setPage("headless")}>Headless Node render</button>
      </nav>
      <div className="page">
        {page === "fractal" && <Fractal />}
        {page === "blackhole" && <BlackHole />}
        {page === "headless" && (
          <div className="video-page">
            <video src="/plasma.mp4" controls autoPlay loop muted playsInline />
            <p>
              這支影片不是瀏覽器算的 —— 是 <code>vgpu/node</code> 在純 Node 裡走 Dawn/Metal
              無頭算圖（150 格 480×270），讀回像素後用 ffmpeg 編成 MP4。同一套 effect/target API，
              瀏覽器與 Node 共用。
            </p>
          </div>
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
