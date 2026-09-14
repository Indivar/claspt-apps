// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * BrandLogo — renders the Claspt wordmark/icon, picking the correct asset
 * for the active theme (light/dark) and the requested size preset. Each
 * preset has a 1x and 2x source for crisp rendering on retina displays.
 */
import { useUIStore, isDarkTheme } from "@/stores/ui-store";

// Vite static imports — each resolves to a hashed URL at build time
import darkSplash from "@/assets/logo-dark-splash.png";
import darkSplash2x from "@/assets/logo-dark-splash@2x.png";
import darkUnlock from "@/assets/logo-dark-unlock.png";
import darkUnlock2x from "@/assets/logo-dark-unlock@2x.png";
import darkHeader from "@/assets/logo-dark-header.png";
import darkHeader2x from "@/assets/logo-dark-header@2x.png";
import darkIcon from "@/assets/logo-dark-icon.png";
import darkIcon2x from "@/assets/logo-dark-icon@2x.png";

import lightSplash from "@/assets/logo-light-splash.png";
import lightSplash2x from "@/assets/logo-light-splash@2x.png";
import lightUnlock from "@/assets/logo-light-unlock.png";
import lightUnlock2x from "@/assets/logo-light-unlock@2x.png";
import lightHeader from "@/assets/logo-light-header.png";
import lightHeader2x from "@/assets/logo-light-header@2x.png";
import lightIcon from "@/assets/logo-light-icon.png";
import lightIcon2x from "@/assets/logo-light-icon@2x.png";

/** Named size presets, each mapping to a distinct asset + pixel dimension. */
type LogoSize = "splash" | "unlock" | "header" | "icon";

const LOGOS: Record<
  "dark" | "light",
  Record<LogoSize, { src: string; src2x: string }>
> = {
  dark: {
    splash: { src: darkSplash, src2x: darkSplash2x },
    unlock: { src: darkUnlock, src2x: darkUnlock2x },
    header: { src: darkHeader, src2x: darkHeader2x },
    icon: { src: darkIcon, src2x: darkIcon2x },
  },
  light: {
    splash: { src: lightSplash, src2x: lightSplash2x },
    unlock: { src: lightUnlock, src2x: lightUnlock2x },
    header: { src: lightHeader, src2x: lightHeader2x },
    icon: { src: lightIcon, src2x: lightIcon2x },
  },
};

const PIXEL_SIZES: Record<LogoSize, number> = {
  splash: 148,
  unlock: 112,
  header: 48,
  icon: 40,
};

/**
 * Theme-aware Claspt logo image.
 * @param size Which logo preset to render (splash/unlock/header/icon).
 * @param className Extra classes forwarded to the underlying `<img>`.
 */
export function BrandLogo({
  size,
  className = "",
}: {
  size: LogoSize;
  className?: string;
}) {
  const { theme } = useUIStore();
  // Resolve "system"/explicit theme down to a concrete dark|light asset set.
  const variant = isDarkTheme(theme) ? "dark" : "light";
  const { src, src2x } = LOGOS[variant][size];
  const px = PIXEL_SIZES[size];

  return (
    <img
      src={src}
      srcSet={`${src} 1x, ${src2x} 2x`}
      width={px}
      height={px}
      alt="Claspt"
      className={className}
      draggable={false}
    />
  );
}
