import './ar.css'

// Keep this document independent of the 3D preview. Default AR loads no three.js
// or WebGL context, leaving the phone's graphics memory to the native camera.
const params = new URLSearchParams(location.search)
const name = (params.get('to') ?? 'Omaris').trim().slice(0, 24).replace(/[^\p{L}\p{N} '’.&!-]/gu, '') || 'Omaris'
const isDefault = name.toLowerCase() === 'omaris'
const link = document.querySelector<HTMLAnchorElement>('#ar-link')!
const status = document.querySelector<HTMLElement>('#ar-status')!
const instructions = document.querySelector<HTMLElement>('#instructions')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const back = document.querySelector<HTMLAnchorElement>('#back-link')!
const poster = document.querySelector<HTMLImageElement>('#poster')!
const supportsQuickLook = link.relList.supports?.('ar') ?? false
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isAndroid = /android/i.test(navigator.userAgent)
const version = '20260920-2'
const quickLookFragment = '#allowsContentScaling=0'

document.querySelector('#ar-name')!.textContent = name
document.title = `Flowers for ${name}, in your room`
back.search = location.search
// Never display the default recipient's gold name for a personalized bouquet.
poster.hidden = !isDefault
let preparedURL: string | undefined

async function preparePersonalized() {
  link.hidden = true
  retry.hidden = true
  status.textContent = 'Preparing your flowers…'
  try {
    const [{ buildBouquet }, { toARUSDZ }] = await Promise.all([import('./bouquet'), import('./ar-export')])
    const { group, materials } = buildBouquet(name)
    try {
      const bytes = await toARUSDZ(group)
      if (preparedURL) URL.revokeObjectURL(preparedURL)
      preparedURL = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/vnd.usdz+zip' }))
      link.href = preparedURL + quickLookFragment
      link.download = 'flowers.usdz'
      link.hidden = false
      status.textContent = 'Ready. Tap “Place your flowers” to open them at real size.'
    } finally {
      group.traverse((object) => {
        const mesh = object as import('three').Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      const textures = new Set<import('three').Texture>()
      for (const material of Object.values(materials)) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
        material.dispose()
      }
      textures.forEach((texture) => texture.dispose())
    }
  } catch {
    status.textContent = 'The flowers couldn’t be prepared. Please try again.'
    retry.hidden = false
  }
}

retry.addEventListener('click', preparePersonalized)
link.addEventListener('click', () => {
  // Observe the tap without preventing navigation or delaying native launch.
  document.querySelector<HTMLElement>('#return-hint')!.hidden = false
})

if (supportsQuickLook) {
  link.href = new URL(`omaris.usdz?v=${version}`, location.href).href + quickLookFragment
  if (!isDefault) void preparePersonalized()
} else if (isAndroid && isDefault) {
  link.removeAttribute('rel')
  const file = new URL(`omaris.glb?v=${version}`, location.href).href
  const fallback = new URL(location.href)
  fallback.searchParams.set('unavailable', '1')
  link.href = `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(file)}&mode=ar_preferred&resizable=false&title=${encodeURIComponent('For ' + name)}` +
    `#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(fallback.href)};end;`
  instructions.textContent = 'Tap below, then move your phone slowly over a table or the floor to place your flowers.'
  if (params.has('unavailable')) {
    status.textContent = 'This phone couldn’t open AR. You can still turn and enjoy the bouquet on the main page.'
  }
} else {
  link.hidden = true
  instructions.textContent = isIOS ? 'Open this page in Safari to place your flowers in your room.' : 'Open this page in Safari on an iPhone or iPad, or Chrome on an Android phone, to place your flowers in your room.'
  status.textContent = 'You can still turn and enjoy the bouquet on the main page.'
}
