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
 * this component. Local `_media/` references are resolved after render:
 * images from their bytes (badged when sealed), PDFs as chips, never inline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Marked } from "marked";
import { usePagesStore } from "@/stores/pages-store";
import { useExtensionStore } from "@/stores/extension-store";
import { readMedia } from "@/lib/commands";
import { extOf } from "@/lib/attachments";
import { showChip, showImage } from "@/lib/preview-attachments";
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
  /** Saves a page edited from the preview, such as an attachment removed. */
  onContentChange?: (content: string) => Promise<void>;
}

/** Renders markdown `content` to sanitized HTML, honoring enabled extensions. */
export default function MarkdownPreview({
  content,
  onContentChange,
}: MarkdownPreviewProps) {
  const folder = usePagesStore((s) => s.activePage?.meta.folder ?? "general");
  const enabledMap = useExtensionStore((s) => s.enabledMap);
  const divRef = useRef<HTMLDivElement>(null);
  // Bumped when an attachment changes on disk (sealed, unsealed) without the
  // markdown changing, so the resolve pass runs again over the same HTML.
  const [mediaVersion, setMediaVersion] = useState(0);
  const refreshMedia = useCallback(() => setMediaVersion((v) => v + 1), []);

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

  // After render, resolve every _media/ reference. Each change to the DOM
  // returns an undo, run on cleanup so a re-resolve starts from the rendered
  // markup rather than from the previous pass's wrappers and chips.
  useEffect(() => {
    if (!divRef.current) return;
    const imgs = divRef.current.querySelectorAll<HTMLImageElement>('img[src^="_media/"]');
    if (imgs.length === 0) return;

    let cancelled = false;
    const undos: (() => void)[] = [];

    imgs.forEach((img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      const inline = extOf(src) !== "pdf";
      img.style.display = "none";
      const placeholder = document.createElement("em");
      placeholder.textContent = `[Loading ${inline ? "image" : "attachment"}: ${img.alt || src}]`;
      placeholder.style.color = "var(--color-text-muted, gray)";
      img.parentNode?.insertBefore(placeholder, img);
      undos.push(() => {
        placeholder.remove();
        img.style.display = "";
      });

      readMedia(folder, src, inline)
        .then((read) => {
          if (cancelled) return;
          placeholder.remove();
          undos.push(inline ? showImage(img, read) : showChip(img, read));
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[media] failed:", src, err);
          placeholder.textContent = `[Failed to load: ${img.alt || src}]`;
          placeholder.style.color = "var(--color-danger, red)";
        });
    });

    return () => {
      cancelled = true;
      undos.reverse().forEach((undo) => undo());
    };
  }, [html, folder, mediaVersion]);

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
      <PreviewContextMenu
        containerRef={divRef}
        folder={folder}
        content={content}
        onContentChange={onContentChange}
        onAttachmentChanged={refreshMedia}
      />
    </>
  );
}
