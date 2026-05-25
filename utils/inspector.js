(function () {
  "use strict";

  class ElementInspector {
    constructor(options = {}) {
      this.onSelect = options.onSelect || null;
      this.active = false;
      this.highlightedElement = null;
      this.previousStyles = null;

      this.handleHover = this.handleHover.bind(this);
      this.handleClick = this.handleClick.bind(this);
      this.handleKeydown = this.handleKeydown.bind(this);
    }

    start(onSelect) {
      if (this.active) this.stop();

      if (typeof onSelect === "function") {
        this.onSelect = onSelect;
      }

      this.active = true;
      document.addEventListener("mouseover", this.handleHover, true);
      document.addEventListener("click", this.handleClick, true);
      document.addEventListener("keydown", this.handleKeydown, true);
    }

    stop() {
      this.active = false;
      this.clearHighlight();
      document.removeEventListener("mouseover", this.handleHover, true);
      document.removeEventListener("click", this.handleClick, true);
      document.removeEventListener("keydown", this.handleKeydown, true);
    }

    handleHover(event) {
      if (!this.active) return;
      this.applyHighlight(event.target);
    }

    handleClick(event) {
      if (!this.active) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const element = event.target;
      const result = {
        element,
        selector: ElementInspector.getUniqueSelector(element),
        text: (element.innerText || element.textContent || "").trim(),
      };

      this.stop();

      if (typeof this.onSelect === "function") {
        this.onSelect(result);
      }
    }

    handleKeydown(event) {
      if (!this.active) return;
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        event.stopPropagation();
        this.stop();
      }
    }

    applyHighlight(element) {
      if (this.highlightedElement === element) return;
      this.clearHighlight();

      this.highlightedElement = element;
      this.previousStyles = {
        border: element.style.border,
        backgroundColor: element.style.backgroundColor,
        cursor: element.style.cursor,
      };

      element.style.border = "2px solid #007bff";
      element.style.backgroundColor = "rgba(0, 123, 255, 0.12)";
      element.style.cursor = "crosshair";
    }

    clearHighlight() {
      if (!this.highlightedElement || !this.previousStyles) return;

      this.highlightedElement.style.border = this.previousStyles.border;
      this.highlightedElement.style.backgroundColor =
        this.previousStyles.backgroundColor;
      this.highlightedElement.style.cursor = this.previousStyles.cursor;

      this.highlightedElement = null;
      this.previousStyles = null;
    }

    static getUniqueSelector(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";

      if (element.id) {
        return `#${CSS.escape(element.id)}`;
      }

      const name = element.getAttribute("name");
      if (name) {
        const selector = `${element.tagName.toLowerCase()}[name="${CSS.escape(
          name,
        )}"]`;
        if (ElementInspector.isUnique(selector)) return selector;
      }

      const classSelector = ElementInspector.getClassSelector(element);
      if (classSelector && ElementInspector.isUnique(classSelector)) {
        return classSelector;
      }

      return ElementInspector.getHierarchySelector(element);
    }

    static getClassSelector(element) {
      const classes = [...element.classList].filter(Boolean);
      if (!classes.length) return "";

      return `${element.tagName.toLowerCase()}.${classes
        .map((className) => CSS.escape(className))
        .join(".")}`;
    }

    static getHierarchySelector(element) {
      const path = [];
      let current = element;

      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.tagName.toLowerCase();

        const name = current.getAttribute("name");
        if (name) {
          selector += `[name="${CSS.escape(name)}"]`;
        } else {
          const classSelector = ElementInspector.getClassSelector(current);
          if (classSelector) selector = classSelector;

          const parent = current.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(
              (sibling) => sibling.tagName === current.tagName,
            );
            if (siblings.length > 1) {
              selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
          }
        }

        path.unshift(selector);
        const fullSelector = path.join(" > ");
        if (ElementInspector.isUnique(fullSelector)) return fullSelector;

        current = current.parentElement;
      }

      return path.join(" > ");
    }

    static isUnique(selector) {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch (err) {
        return false;
      }
    }
  }

  window.ElementInspector = ElementInspector;
})();
