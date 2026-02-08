import { useState, useEffect, useRef } from "react";

export interface MuxTunnelSettings {
  resolver: string;
  projects: {
    ignore: string[];
    maxDepth: number;
  };
  background: {
    image: string | null;
    size: string;
    opacity: number;
    filter: string | null;
  };
  terminal: {
    fontSize: number;
    fontFamily: string;
  };
  window: {
    padding: number;
  };
}

export function useSettings(pollInterval = 5000): MuxTunnelSettings {
  const [settings, setSettings] = useState<MuxTunnelSettings>({
    resolver: "muxtunnel.projects",
    projects: { ignore: [], maxDepth: 3 },
    background: { image: null, size: "cover", opacity: 0.15, filter: null },
    terminal: { fontSize: 14, fontFamily: "monospace" },
    window: { padding: 0 },
  });
  const versionRef = useRef(-1);

  useEffect(() => {
    let active = true;

    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const data = await res.json();
        if (!active) return;
        if (data.version !== versionRef.current) {
          versionRef.current = data.version;
          setSettings(data.settings);
        }
      } catch {
        // Ignore fetch errors
      }
    };

    fetchSettings();
    const interval = setInterval(fetchSettings, pollInterval);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pollInterval]);

  return settings;
}

export function getBackgroundImageUrl(settings: MuxTunnelSettings): string | null {
  const image = settings.background?.image;
  if (!image) return null;

  if (image.startsWith("http://") || image.startsWith("https://")) {
    return image;
  }

  // Local file path — served through the API
  return "/api/settings/background";
}
