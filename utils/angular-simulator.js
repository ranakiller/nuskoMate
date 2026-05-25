window.simulateAngularInput = function (element, value) {
    if (!element || value === undefined || value === null) return;
    if (element.value === value) return;

    const lastValue = element.value;
    element.value = value;
    
    // This part is crucial for Angular/React to "see" the change
    const tracker = element._valueTracker;
    if (tracker) tracker.setValue(lastValue);

    // Trigger events in order
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    
    // For some strict forms, we trigger a blur to simulate "leaving" the field
    element.dispatchEvent(new Event("blur", { bubbles: true }));
};