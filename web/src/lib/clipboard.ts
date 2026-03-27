export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }

  return new Promise((resolve, reject) => {
    const el = document.createElement("textarea")
    el.value = text
    el.style.cssText = "position:fixed;opacity:0;pointer-events:none"
    document.body.appendChild(el)
    el.focus()
    el.select()

    try {
      document.execCommand("copy")
      resolve()
    } catch (error) {
      reject(error)
    } finally {
      document.body.removeChild(el)
    }
  })
}
