/**
 * An iPhone or iPad, whatever the browser (every one there is WebKit). iPadOS asks for desktop pages,
 * so an iPad says it is a Mac; it is the Mac with a touch screen.
 */
export const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
