import { useEffect, useState } from "react";

import { storageGet, storageSet } from "@/lib/storage";

// V2 默认炭黑朱红；用户可切暖白，保留既有主题选择。
// 机制：亮色时给 <html> 加 .light（暗色为无类名的默认态）。
export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    const saved = storageGet("vr-theme");
    if (saved) return saved === "dark";
    return true; // 默认暗色
  });

  useEffect(() => {
    document.documentElement.classList.toggle("light", !dark);
    document.documentElement.classList.toggle("dark", dark);
    storageSet("vr-theme", dark ? "dark" : "light");
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}
