// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * presentations.ts — turn a note into a slide deck using `---` separators.
 *
 * Purely a post-processor: when the rendered preview contains `<hr>` elements it
 * treats each as a slide boundary and injects a "Present" control that opens a
 * fullscreen slideshow. No Marked hook or lazy library.
 */
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";

/** Presentations extension — horizontal rule (---) slide separators with Present button. */
const presentationsExtension: MarkdownExtension = {
  id: "presentations",
  name: "Presentations",
  description: "--- slide separators with fullscreen Present mode",
  category: "document",
  defaultEnabled: false,
  toolbarInsert: "\n---\n\n## Slide Title\n\nContent here\n",
  toolbarOrder: 95,
  iconPath:
    "M10 8v8l5-4-5-4zm9-5H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z",

  postprocess: (container: HTMLElement) => {
    // Only activate if there are <hr> elements (slide separators)
    const hrs = container.querySelectorAll("hr");
    if (hrs.length === 0) return;

    // Build slide boundaries: content between <hr> elements
    const slides: HTMLElement[] = [];
    let current = document.createElement("div");
    current.className = "slide-content";

    for (const child of Array.from(container.children)) {
      if (child.tagName === "HR") {
        if (current.children.length > 0) {
          slides.push(current);
        }
        current = document.createElement("div");
        current.className = "slide-content";
      } else {
        current.appendChild(child.cloneNode(true));
      }
    }
    if (current.children.length > 0) {
      slides.push(current);
    }

    // If fewer than 2 slides, don't treat as presentation
    if (slides.length < 2) return;

    // Add slide indicators
    for (let i = 0; i < slides.length; i++) {
      const indicator = document.createElement("div");
      indicator.className = "slide-indicator";
      indicator.textContent = `Slide ${i + 1} / ${slides.length}`;
      slides[i]!.insertBefore(indicator, slides[i]!.firstChild);
    }

    // Add Present button
    const btn = document.createElement("button");
    btn.className = "present-btn";
    btn.textContent = "▶ Present";
    btn.addEventListener("click", () => enterPresentation(slides));
    container.insertBefore(btn, container.firstChild);
  },
};

/** Enter fullscreen presentation mode. */
function enterPresentation(slides: HTMLElement[]): void {
  let currentSlide = 0;

  const overlay = document.createElement("div");
  overlay.className = "presentation-overlay";

  const slideContainer = document.createElement("div");
  slideContainer.className = "presentation-slide";

  const controls = document.createElement("div");
  controls.className = "presentation-controls";

  const counter = document.createElement("span");
  counter.className = "presentation-counter";

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "← Prev";
  prevBtn.className = "presentation-nav";

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next →";
  nextBtn.className = "presentation-nav";

  const exitBtn = document.createElement("button");
  exitBtn.textContent = "✕ Exit";
  exitBtn.className = "presentation-exit";

  controls.appendChild(prevBtn);
  controls.appendChild(counter);
  controls.appendChild(nextBtn);
  controls.appendChild(exitBtn);
  overlay.appendChild(slideContainer);
  overlay.appendChild(controls);
  document.body.appendChild(overlay);

  function showSlide(idx: number): void {
    currentSlide = Math.max(0, Math.min(idx, slides.length - 1));
    slideContainer.textContent = "";
    const clone = slides[currentSlide]!.cloneNode(true) as HTMLElement;
    // Remove the slide indicator in fullscreen
    const ind = clone.querySelector(".slide-indicator");
    if (ind) ind.remove();
    slideContainer.appendChild(clone);
    counter.textContent = `${currentSlide + 1} / ${slides.length}`;
    prevBtn.disabled = currentSlide === 0;
    nextBtn.disabled = currentSlide === slides.length - 1;
  }

  function cleanup(): void {
    document.removeEventListener("keydown", handleKey);
    overlay.remove();
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      showSlide(currentSlide + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      showSlide(currentSlide - 1);
    } else if (e.key === "Escape") {
      cleanup();
    }
  }

  prevBtn.addEventListener("click", () => showSlide(currentSlide - 1));
  nextBtn.addEventListener("click", () => showSlide(currentSlide + 1));
  exitBtn.addEventListener("click", cleanup);
  document.addEventListener("keydown", handleKey);

  showSlide(0);

  // Try fullscreen
  overlay.requestFullscreen?.().catch(() => {
    // Fullscreen not available — works fine without it
  });
}

registerExtension(presentationsExtension);

export default presentationsExtension;
