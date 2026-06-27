(function () {
  "use strict";

  let isEnabled = false;
  let translateInterval = null;
  let observer = null;
  let debounceTimer = null;
  const lastTranslated = {};
  const pendingTranslations = new Set();

  const enToArMap = {
    a: "\u0627",
    b: "\u0628",
    c: "\u0643",
    d: "\u062f",
    e: "\u064a",
    f: "\u0641",
    g: "\u062c",
    h: "\u0647",
    i: "\u064a",
    j: "\u062c",
    k: "\u0643",
    l: "\u0644",
    m: "\u0645",
    n: "\u0646",
    o: "\u0648",
    p: "\u0628",
    q: "\u0642",
    r: "\u0631",
    s: "\u0633",
    t: "\u062a",
    u: "\u0648",
    v: "\u0641",
    w: "\u0648",
    x: "\u0643\u0633",
    y: "\u064a",
    z: "\u0630",
    0: "\u0660",
    1: "\u0661",
    2: "\u0662",
    3: "\u0663",
    4: "\u0664",
    5: "\u0665",
    6: "\u0666",
    7: "\u0667",
    8: "\u0668",
    9: "\u0669",
    " ": " ",
    "-": "-",
    "'": "",
    '"': "",
  };

  function setAngularValue(input, value) {
    if (typeof window.simulateAngularInput === "function") {
      window.simulateAngularInput(input, value);
      return;
    }

    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function transliterateToArabic(text) {
    return text
      .split("")
      .map((char) => enToArMap[char.toLowerCase()] || char)
      .join("");
  }

  function translateAndFillSmart(selectorEn, selectorAr, fieldKey) {
    const en = document.querySelector(selectorEn);
    const ar = document.querySelector(selectorAr);
    if (!en || !ar) return;

    const inputText = en.value.trim();
    const currentArValue = ar.value.trim();
    if (!inputText) return;

    if (inputText.toLowerCase() === "un") {
      setAngularValue(ar, "\u0627\u0646");
      return;
    }

    if (currentArValue !== "" && lastTranslated[fieldKey] === inputText) return;
    if (pendingTranslations.has(fieldKey)) return;

    lastTranslated[fieldKey] = inputText;
    pendingTranslations.add(fieldKey);

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(inputText)}`;

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        const translated = data[0]?.map((seg) => seg[0]).join("");
        const isInvalid =
          !translated ||
          translated.toLowerCase() === inputText.toLowerCase() ||
          /[a-z]/i.test(translated);

        const finalText = isInvalid
          ? transliterateToArabic(inputText)
          : translated;

        setAngularValue(ar, finalText);
      })
      .catch(() => {
        setAngularValue(ar, transliterateToArabic(inputText));
      })
      .finally(() => {
        pendingTranslations.delete(fieldKey);
      });
  }

  function watchAndTranslate() {
    if (!isEnabled) return;

    translateAndFillSmart(
      'div[formgroupname="firstName"] input[formcontrolname="en"]',
      'div[formgroupname="firstName"] input[formcontrolname="ar"]',
      "firstName",
    );
    translateAndFillSmart(
      'div[formgroupname="secondName"] input[formcontrolname="en"]',
      'div[formgroupname="secondName"] input[formcontrolname="ar"]',
      "secondName",
    );
    translateAndFillSmart(
      'div[formgroupname="thirdName"] input[formcontrolname="en"]',
      'div[formgroupname="thirdName"] input[formcontrolname="ar"]',
      "thirdName",
    );
    translateAndFillSmart(
      'div[formgroupname="familyName"] input[formcontrolname="en"]',
      'div[formgroupname="familyName"] input[formcontrolname="ar"]',
      "familyName",
    );
    translateAndFillSmart(
      'div[formgroupname="name"] input[formcontrolname="en"]',
      'div[formgroupname="name"] input[formcontrolname="ar"]',
      "serviceName",
    );
    translateAndFillSmart(
      'div[formgroupname="details"] textarea[formcontrolname="en"]',
      'div[formgroupname="details"] textarea[formcontrolname="ar"]',
      "details",
    );
    translateAndFillSmart(
      'input[placeholder*="English"]',
      'input[placeholder*="Arabic"]',
      "placeholderNames",
    );
  }

  function startModule() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(watchAndTranslate, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (!translateInterval) {
      translateInterval = setInterval(watchAndTranslate, 1000);
    }
    watchAndTranslate();
  }

  function stopModule() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (translateInterval) {
      clearInterval(translateInterval);
      translateInterval = null;
    }
    clearTimeout(debounceTimer);
  }

  // Premium feature — requires a license that includes this tool.
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("translate");

  chrome.storage.local.get(["extensionEnabled", "moduleTranslate"], (result) => {
    if (result.extensionEnabled === false) return;
    isEnabled = !!result.moduleTranslate && premiumOK();
    if (isEnabled) startModule();
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local") {
      if (changes.extensionEnabled && !changes.extensionEnabled.newValue) { isEnabled = false; stopModule(); return; }
    }
    if (namespace === "local" && changes.moduleTranslate) {
      isEnabled = !!changes.moduleTranslate.newValue && premiumOK();
      isEnabled ? startModule() : stopModule();
    }
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => {
    chrome.storage.local.get(["extensionEnabled", "moduleTranslate"], (r) => {
      isEnabled = r.extensionEnabled !== false && !!r.moduleTranslate && premiumOK();
      isEnabled ? startModule() : stopModule();
    });
  });
})();
