(function () {
  "use strict";

  const TEXT_INPUT_TYPES = ["text", "email", "tel", "number", "password", "search", "url", ""];
  const BUTTON_INPUT_TYPES = ["button", "submit", "reset"];

  function findInputLabel(element) {
    // 1. aria-label
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    // 2. aria-labelledby
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map((id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : ""; })
        .filter(Boolean).join(" ");
      if (text) return text;
    }

    // 3. label[for=id]  — works even when label comes after the input (p-float-label)
    if (element.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) return label.textContent.trim();
      } catch (_) {}
    }

    // 4. Browser-native .labels (covers <label> wrapping the input)
    if (element.labels && element.labels.length > 0) {
      const text = element.labels[0].textContent.trim();
      if (text) return text;
    }

    // 5. Nearest <label> inside the same parent container (Angular form groups)
    const parent = element.parentElement;
    if (parent) {
      const label = parent.querySelector("label");
      if (label) return label.textContent.trim();
    }

    // 6. placeholder as last resort
    return element.placeholder ? element.placeholder.trim() : null;
  }

  function detectElementType(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return { type: "button", meta: {} };
    }

    const tag = element.tagName.toLowerCase();
    const inputType = (element.type || "").toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();

    if (tag === "input" && inputType === "checkbox") {
      return { type: "checkbox", meta: { currentState: element.checked } };
    }

    if (tag === "input" && inputType === "radio") {
      return { type: "radio", meta: { name: element.name || "", currentValue: element.value } };
    }

    if (tag === "select") {
      const options = Array.from(element.options)
        .slice(0, 20)
        .map((opt) => ({ value: opt.value, text: opt.text.trim() }));
      return { type: "dropdown", meta: { currentValue: element.value, options } };
    }

    if (tag === "textarea" || (tag === "input" && TEXT_INPUT_TYPES.includes(inputType))) {
      return {
        type: "input",
        meta: {
          currentValue: element.value,
          inputType: inputType || "text",
          placeholder: element.placeholder || "",
          label: findInputLabel(element),
        },
      };
    }

    if (
      tag === "button" ||
      (tag === "input" && BUTTON_INPUT_TYPES.includes(inputType)) ||
      role === "button" ||
      tag === "a"
    ) {
      return {
        type: "button",
        meta: { text: (element.innerText || element.textContent || "").trim() },
      };
    }

    const ariaHasPopup = element.getAttribute("aria-haspopup");
    const ariaExpanded = element.getAttribute("aria-expanded");
    if (ariaHasPopup === "listbox" || ariaExpanded !== null) {
      return { type: "dropdown", meta: { currentValue: "", options: [], custom: true } };
    }

    return { type: "button", meta: { text: (element.innerText || element.textContent || "").trim() } };
  }

  window.detectElementType = detectElementType;
})();
