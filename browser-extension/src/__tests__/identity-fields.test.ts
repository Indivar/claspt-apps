// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Detecting the personal-detail fields on a checkout or signup form.
 *
 * The traps here are all about one field being mistaken for another, which
 * matters more than a field being missed: a missed field leaves a box empty,
 * a confused one puts a surname in the street box or a whole name in a box
 * that wanted the first name only.
 */
import { describe, it, expect, afterEach } from "vitest";
import { detectFields, isIdentityField } from "@/content/form-detector";
import type { DetectedField } from "@/content/form-detector";

function render(html: string) {
  // The markup is a literal fixture from this file, never page content. The
  // rule exists to stop untrusted input reaching innerHTML in the content
  // script, which is a different situation from building a test DOM.
  // eslint-disable-next-line no-unsanitized/property
  document.body.innerHTML = html;
  // jsdom implements no layout: every element reports a zero-sized box and a
  // null offsetParent, and the detector treats both as hidden. Give each input
  // the geometry a real browser would report so visibility is not what is
  // under test here.
  for (const el of document.querySelectorAll("input")) {
    el.getBoundingClientRect = () =>
      ({ width: 200, height: 30, top: 0, left: 0, bottom: 30, right: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(el, "offsetParent", { value: document.body, configurable: true });
  }
}

function typeOf(fields: DetectedField[], selector: string): string | undefined {
  const el = document.querySelector(selector);
  return fields.find((f) => f.element === el)?.type;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("identity field detection", () => {
  it("uses the autocomplete attribute when the site provides one", () => {
    render(`
      <form>
        <input id="a" autocomplete="given-name" />
        <input id="b" autocomplete="family-name" />
        <input id="c" autocomplete="street-address" />
        <input id="d" autocomplete="address-level2" />
        <input id="e" autocomplete="address-level1" />
        <input id="f" autocomplete="postal-code" />
        <input id="g" autocomplete="tel" />
      </form>`);
    const fields = detectFields();
    expect(typeOf(fields, "#a")).toBe("first_name");
    expect(typeOf(fields, "#b")).toBe("last_name");
    expect(typeOf(fields, "#c")).toBe("street_1");
    expect(typeOf(fields, "#d")).toBe("city");
    expect(typeOf(fields, "#e")).toBe("state");
    expect(typeOf(fields, "#f")).toBe("postal_code");
    expect(typeOf(fields, "#g")).toBe("phone");
  });

  it("falls back to names and placeholders when it does not", () => {
    render(`
      <form>
        <input id="a" name="fname" />
        <input id="b" name="surname" />
        <input id="c" name="address1" />
        <input id="d" name="zipcode" />
      </form>`);
    const fields = detectFields();
    expect(typeOf(fields, "#a")).toBe("first_name");
    expect(typeOf(fields, "#b")).toBe("last_name");
    expect(typeOf(fields, "#c")).toBe("street_1");
    expect(typeOf(fields, "#d")).toBe("postal_code");
  });

  it("does not put the whole name in a box that asked for the first name", () => {
    // "First name" contains "name". Matching full_name first would fill both
    // boxes with the same value.
    render(`<form><input id="a" placeholder="First name" /><input id="b" placeholder="Last name" /></form>`);
    const fields = detectFields();
    expect(typeOf(fields, "#a")).toBe("first_name");
    expect(typeOf(fields, "#b")).toBe("last_name");
  });

  it("tells the second address line from the first", () => {
    // "Address line 2" contains "address".
    render(`<form><input id="a" name="address_line1" /><input id="b" name="address_line2" /></form>`);
    const fields = detectFields();
    expect(typeOf(fields, "#a")).toBe("street_1");
    expect(typeOf(fields, "#b")).toBe("street_2");
  });

  it("leaves the name on a card to the card, not the person", () => {
    // Both are "a name". The card selectors run first and win.
    render(`<form><input id="a" autocomplete="cc-name" /><input id="b" autocomplete="name" /></form>`);
    const fields = detectFields();
    expect(typeOf(fields, "#a")).toBe("card_name");
    expect(typeOf(fields, "#b")).toBe("full_name");
  });

  it("leaves a login form alone", () => {
    render(`<form><input id="a" name="username" /><input id="b" type="password" /></form>`);
    const fields = detectFields();
    expect(typeOf(fields, "#a")).toBe("username");
    expect(typeOf(fields, "#b")).toBe("password");
    expect(fields.some((f) => isIdentityField(f.type))).toBe(false);
  });

  it("classifies identity types apart from logins and cards", () => {
    expect(isIdentityField("city")).toBe(true);
    expect(isIdentityField("password")).toBe(false);
    expect(isIdentityField("card_number")).toBe(false);
  });
});
