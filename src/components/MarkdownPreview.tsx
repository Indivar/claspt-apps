// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Rendered markdown preview pane.
 *
 * Builds a `marked` + DOMPurify pipeline whose behavior depends on the set of
 * enabled preview extensions, loading their libraries lazily. ALL generated HTML
 * is sanitized through DOMPurify inside `renderMarkdown()` before it reaches
 * `dangerouslySetInnerHTML` — this is the security boundary against injected
 * markup in note content. Extension post-processors then run against the live DOM.
 *
 * Note: this preview renders the raw markdown source, so `:::secret` blocks appear
 * as literal text here; decrypted secret values are shown by `SecretCard`, not by
 * this component. Local `_media/` images are resolved to data URLs via a Tauri
 * command after render.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Marked } from "marked";
import { usePagesStore } from "@/stores/pages-store";
import { useExtensionStore } from "@/stores/extension-store";
import { readMediaDataUrl } from "@/lib/commands";
import type { PurifyOptions } from "@/lib/extensions/preview-pipeline";
import {
  createMarkedInstance,
  createPurifyConfig,
  ensureAllLoaded,
  renderMarkdown,
  runPostProcessors,
} from "@/lib/extensions/preview-pipeline";
import type { ExtensionEnabledMap } from "@/lib/extensions/types";
import { PreviewContextMenu } from "@/components/PreviewContextMenu";

interface MarkdownPreviewProps {
  content: string;
}

/** Renders markdown `content` to sanitized HTML, honoring enabled extensions. */
export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const folder = usePagesStore((s) => s.activePage?.meta.folder ?? "general");
  const enabledMap = useExtensionStore((s) => s.enabledMap);
  const divRef = useRef<HTMLDivElement>(null);

  // Pipeline state: rebuilt when enabled extensions change and libraries finish loading
  const [pipeline, setPipeline] = useState<{
    markedInstance: Marked;
    purifyConfig: PurifyOptions;
    loadedMap: ExtensionEnabledMap;
  } | null>(null);

  // Load extension libraries when enabledMap changes, then build pipeline
  useEffect(() => {
    let cancelled = false;
    ensureAllLoaded(enabledMap)
      .then(() => {
        if (cancelled) return;
        setPipeline({
          markedInstance: createMarkedInstance(enabledMap),
          purifyConfig: createPurifyConfig(enabledMap),
          loadedMap: enabledMap,
        });
      })
      .catch((err) => {
        console.error("[extensions] failed to load:", err);
        if (cancelled) return;
        // Build pipeline with whatever loaded successfully
        setPipeline({
          markedInstance: createMarkedInstance(enabledMap),
          purifyConfig: createPurifyConfig(enabledMap),
          loadedMap: enabledMap,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabledMap]);

  // Render HTML (sanitized through DOMPurify)
  const html = useMemo(() => {
    if (!pipeline) {
      // Libraries still loading — render without extensions
      const md = createMarkedInstance({});
      const cfg = createPurifyConfig({});
      return renderMarkdown(content, md, cfg, {});
    }
    return renderMarkdown(
      content,
      pipeline.markedInstance,
      pipeline.purifyConfig,
      pipeline.loadedMap,
    );
  }, [content, pipeline]);

  // Run extension post-processors after HTML is rendered into the DOM
  useEffect(() => {
    if (!divRef.current || !pipeline) return;
    return runPostProcessors(divRef.current, pipeline.loadedMap);
  }, [html, pipeline]);

  // After render, resolve _media/ image paths via Tauri command
  useEffect(() => {
    if (!divRef.current) return;
    const imgs = divRef.current.querySelectorAll<HTMLImageElement>('img[src^="_media/"]');
    if (imgs.length === 0) return;

    let cancelled = false;
    const placeholders: HTMLElement[] = [];

    imgs.forEach((img) => {
      const src = img.getAttribute("src")!;
      img.style.display = "none";
      const placeholder = document.createElement("em");
      placeholder.textContent = `[Loading image: ${img.alt || src}]`;
      placeholder.style.color = "var(--color-text-muted, gray)";
      img.parentNode?.insertBefore(placeholder, img);
      placeholders.push(placeholder);

      readMediaDataUrl(folder, src)
        .then((dataUrl) => {
          if (cancelled) return;
          img.src = dataUrl;
          img.style.display = "";
          img.loading = "lazy";
          placeholder.remove();
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[media] failed:", src, err);
          placeholder.textContent = `[Failed to load image: ${img.alt || src}]`;
          placeholder.style.color = "red";
        });
    });

    return () => {
      cancelled = true;
      placeholders.forEach((p) => p.remove());
    };
  }, [html, folder]);

  {
    /* All content is sanitized through DOMPurify in renderMarkdown() */
  }
  return (
    <>
      <div
        ref={divRef}
        className="claspt-prose px-6 py-4"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <PreviewContextMenu containerRef={divRef} />
    </>
  );
}
