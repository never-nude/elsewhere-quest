#if DEBUG
import Foundation

// Explicit launch-argument diagnostics. Release binaries contain no smoke runner.
enum DebugSmoke {
    static let initialScript = #"""
      const deadline=Date.now()+30000;
      while(!window.gessoStudio && !window.gesso && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
      if(!window.gessoStudio && !window.gesso) throw Error('Editor did not initialize');
      const bridge=window.webkit.messageHandlers.gesso;
      const ping=await bridge.postMessage({op:'ping',args:{}});
      if(!ping.ok || ping.result.api!==1) throw Error('Native ping rejected');
      const size=5*1024*1024;
      const bytes=new Uint8Array(size);
      for(let i=0;i<size;i++) bytes[i]=i&255;
      const made=await bridge.postMessage({op:'xfer.create',args:{name:'smoke.bin',type:'application/octet-stream',size}});
      if(!made.ok) throw Error(JSON.stringify(made));
      const url=made.result.url;
      try {
        const post=await fetch(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes.buffer});
        const receipt=await post.json();
        if(post.status!==200 || receipt.size!==size) throw Error('ArrayBuffer POST: '+JSON.stringify(receipt));
        const read=new Uint8Array(await(await fetch(url)).arrayBuffer());
        if(read.length!==size) throw Error('5MB transfer length mismatch');
        for(let i=0;i<size;i++) if(read[i]!==bytes[i]) throw Error('5MB transfer byte mismatch');
      } finally { await bridge.postMessage({op:'xfer.release',args:{url}}); }
      const jpeg=await new Promise((resolve,reject)=>{
        const worker=new Worker('/gesso/workers/export-worker.js',{type:'module'});
        const timer=setTimeout(()=>{worker.terminate();reject(Error('JPEG module worker timeout'));},15000);
        worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(Error(e.message));};
        worker.onmessage=({data})=>{clearTimeout(timer);worker.terminate();data.type==='blob'?resolve({type:data.blob.type,size:data.blob.size}):reject(Error(data.message));};
        const pixels=new Uint8ClampedArray(32*32*4);pixels.fill(255);
        worker.postMessage({type:'encode',buffer:pixels.buffer,w:32,h:32,quality:.92},[pixels.buffer]);
      });
      localStorage.setItem('gesso-native-smoke','kept');
      await new Promise((resolve,reject)=>{
        const request=indexedDB.open('gesso-native-smoke',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('values');
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{const db=request.result;const tx=db.transaction('values','readwrite');tx.objectStore('values').put('kept','key');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
      });
      return {editor:true,studio:!!window.gessoStudio,origin:location.origin,secure:isSecureContext,postBytes:size,moduleJPEG:jpeg,ping:ping.result};
      """#

    static let reloadScript = #"""
      const indexed=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('gesso-native-smoke',1);
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{const db=request.result;const get=db.transaction('values').objectStore('values').get('key');get.onsuccess=()=>{db.close();resolve(get.result);};get.onerror=()=>reject(get.error);};
      });
      const local=localStorage.getItem('gesso-native-smoke');
      localStorage.removeItem('gesso-native-smoke');indexedDB.deleteDatabase('gesso-native-smoke');
      if(indexed!=='kept' || local!=='kept') throw Error('Storage did not survive reload');
      return {indexedDB:true,localStorage:true,reloaded:true};
      """#

    static func write(_ result: [String: Any]) {
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: directory.appendingPathComponent("gesso-smoke.json"), options: .atomic)
        } catch { NSLog("Gesso smoke report could not be written") }
    }
}
#endif
