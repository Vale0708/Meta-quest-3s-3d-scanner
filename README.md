# Quest 3D-Scanner

WebXR-App für die **Meta Quest 3 / 3S**: Räume und Objekte scannen, mit dem Controller nachmessen und als **STL, STEP oder OBJ** für CAD-Programme exportieren (Fusion 360, SolidWorks, FreeCAD, Inventor …).

Die App läuft direkt im **Quest-Browser** und wird nicht installiert: kein Sideloading, kein Entwicklermodus, kein Unity.

## Funktionen

| Modus | Größe | Voxel | Gedacht für |
|---|---|---|---|
| **Kleine Objekte** | bis ~30 cm | 4 mm | Teile auf dem Tisch |
| **Mittelgroße Objekte** | ~30 cm – 2 m | 10 mm | Möbel, Geräte, Fahrrad |
| **Raum** | ganzes Zimmer | 30 mm | Zimmer als Modell, zusätzlich mit dem Raum-Mesh der Quest (Space Setup) |

- **Live-Vorschau:** Die bereits erfasste Oberfläche wird farbig über die echte Welt gelegt, so siehst du sofort, wo noch Lücken sind.
- **Farbe (optional):** Mit einer Kamera der Quest werden die echten Farben mit aufgenommen und pro Punkt gemittelt. Siehe [Farbe](#farbe).
- **Messwerkzeuge mit der schwebenden Messspitze** (roter Punkt 7 cm vor dem Controller, in 1-cm-Schritten verstellbar): Punkt, Abstand, **Kreis/Ø** (z. B. Kleiderstange: 3+ Punkte rundherum → Durchmesser + Achse) und **Ebene** (z. B. Wand, Tischplatte). Das Controller-Tracking ist deutlich genauer als die Tiefenkamera, darum ist das der Weg für exakte Maße.
- **Optional: Spitzen-Kalibrierung** (Pivot-Kalibrierung, wie bei Messarmen) für eine echte Spitze am Controller.
- **Export** in Millimetern, Z nach oben:
  - **STL** (binär): Standard für Mesh-Import und 3D-Druck
  - **STEP** (AP214, facettierte Flächen): öffnet sich als Flächenkörper im CAD, automatisch auf max. N Dreiecke reduziert
  - **OBJ** mit getrennten Objekten (Scan / Raum-Mesh / Messungen) und Vertex-Farben
  - **PLY** mit Vertex-Farben (MeshLab, Blender, CloudCompare)
  - STEP enthält die Farben als Flächenfarben (Fusion 360 zeigt sie an)
  - **CSV-Messprotokoll** (Excel-tauglich, deutsches Format)
- **Aufbereitung beim Export:** Glätten (Taubin, ohne Schrumpfen), Rauschinseln entfernen, Tischauflage abschneiden, **Raum automatisch an den Wänden ausrichten** (Wände parallel zu X/Y).
- Scans werden **auf der Quest gespeichert** (IndexedDB) und können später erneut mit anderen Einstellungen exportiert werden.
- **Simulation:** Am PC lässt sich ohne Brille alles durchspielen.

## Starten

WebXR braucht **https://**. Drei Möglichkeiten, von einfach bis „ohne GitHub“:

### A) GitHub Pages (empfohlen)
Die App ist unter **https://vale0708.github.io/Meta-quest-3s-3d-scanner/** erreichbar. Nach jedem Push auf `main` testet der Workflow „Pages“ den Code und veröffentlicht ihn automatisch über den Branch `gh-pages`.
Falls die Seite nicht erreichbar ist: **Settings → Pages → Source: „Deploy from a branch“**, Branch `gh-pages`, Ordner `/ (root)`.
URL im Quest-Browser öffnen (Tipp: als Lesezeichen speichern).

### B) Lokal vom PC im WLAN
Voraussetzung: [Node.js](https://nodejs.org) ab Version 18.
```bash
npm install
npm start
```
Der Server zeigt eine Adresse wie `https://192.168.x.x:8443`. Öffne sie im Quest-Browser. Bei der Zertifikatswarnung **„Erweitert“ → „Weiter zu …“** wählen. Das Zertifikat ist selbst signiert und bleibt lokal. PC und Quest müssen im selben WLAN sein.

### C) Per USB-Kabel (Entwicklermodus nötig)
`npm start`, dann `adb reverse tcp:8080 tcp:8080` und auf der Quest `http://localhost:8080` öffnen.

## Bedienung

| Controller | Aktion |
|---|---|
| **Linker Controller** | trägt das Menü (X blendet es aus/ein, Y wechselt das Messwerkzeug) |
| **Rechter Trigger** | Menüknopf drücken / Box absetzen / Messpunkt setzen |
| **A** | Scan starten / pausieren |
| **B** | letzten Messpunkt bzw. letzte Messung rückgängig |
| **Rechter Grip** (halten) | Scan-Box verschieben |
| **Rechter Stick** | Box größer/kleiner (hoch/runter), drehen (links/rechts) |
| **Linker Stick** | Box-Höhe |

**Ablauf Objekt-Scan**
1. Objekt frei auf einen Tisch stellen, Modus wählen, **In VR starten**.
2. Die gelbe Box hängt am roten Punkt vor dem Controller. Punkt **neben dem Objekt auf die Tischplatte** halten und Trigger drücken: Die Box steht jetzt auf dem Tisch. Mit dem Stick die Größe anpassen, das Objekt muss ganz drin sein.
3. **A** drücken, dann langsam um das Objekt herumgehen und es auch schräg von oben ansehen. In den ersten Sekunden den Kopf einmal hoch/runter und links/rechts bewegen: Die App kalibriert dabei automatisch die Ausrichtung des Tiefenbilds.
4. Wenn die Vorschau geschlossen aussieht: **Fertig & Speichern**. Danach öffnet sich auf der Startseite der Export.

**Ablauf Raum-Scan**
1. Vorher in den Quest-Einstellungen einen **Raum einrichten** (Space Setup). Dann liefert die Quest zusätzlich ihr eigenes Raum-Mesh mit. Alternativ in der App auf „Raum-Setup“ tippen.
2. In der Raummitte starten, **A**, dann langsam alle Wände, Ecken, Boden und Decke abschauen, für Details auch näher rangehen.
3. Wichtige Maße zusätzlich mit dem **Messwerkzeug** antasten, z. B. Kleiderstange mit *Kreis/Ø* (3–6 Punkte rundherum, dann „Messung fertig“) und die Wandhalter mit *Punkt*.

## Farbe

1. Auf der Startseite **„Kamera testen“** drücken und den Kamerazugriff erlauben. Erscheint ein Live-Bild der Umgebung, kann der Browser Farbe liefern. Bei mehreren Kameras die linke/vordere auswählen.
2. **„Farbe aufnehmen“** anhaken und den Scan starten.
3. In VR **erst kurz scannen**, dann **„Farbe ausrichten“**: Das Kamerabild wird live auf die Vorschau projiziert.
   - Rechter Stick: drehen (links/rechts) und kippen (hoch/runter)
   - Linker Stick: Sichtfeld (FOV) anpassen
   - So lange anpassen, bis Kanten und Muster im projizierten Bild genau auf den echten Kanten liegen, dann **„Ausrichten fertig“**. Die Einstellung bleibt gespeichert, das musst du nur einmal machen.
4. Weiter scannen. Langsame Bewegungen geben schärfere Farben.

**Ehrlicher Hinweis:** Meta gibt die Passthrough-Kameras nur nativen Apps offiziell frei (Passthrough Camera API). Ob der Quest-Browser sie über `getUserMedia` herausgibt, hängt von der Browser-Version ab. Das zeigt dir der Kamera-Test sofort. Klappt es nicht, funktioniert der Scan trotzdem, nur ohne Farbe. Dann wäre eine native Unity-App der nächste Schritt.

**Koordinatensystem im Export:** Millimeter, Z oben. Bei Objekten liegt der Nullpunkt in der Mitte der Box-Unterseite (also auf der Tischplatte). Beim Raum liegt er auf dem Boden unter der Startposition, und die Achsen sind auf Wunsch parallel zu den Wänden.

**Dateien auf den PC bringen:** Exporte landen im Download-Ordner der Quest. Wege von dort auf den PC:
- USB-Kabel: Quest erscheint als Laufwerk → `Download`
- im Quest-Browser bei Google Drive/OneDrive hochladen

## Was ist realistisch? (ehrliche Einordnung)

Die Quest 3S hat **keinen** Tiefensensor (ToF). Die Tiefe wird aus den Tracking-Kameras geschätzt (Meta Depth API): niedrige Auflösung, Rauschen im **Zentimeterbereich**. Das Mitteln über viele Bilder (TSDF-Fusion) glättet das deutlich, aber:

- **Räume und Möbel:** gut brauchbar. Wände, Nischen, Möbelpositionen und Raumhöhe sollten auf ~1–2 cm stimmen (am echten Gerät noch nicht nachgemessen).
- **Mittelgroße Objekte:** Form und Hüllmaße gut, feine Details (< 2 cm) verschwinden.
- **Kleine Objekte:** grobe Form. Für Passteile reicht das meist nicht. Dafür ist das **Antasten mit der Messspitze** da (~1–2 mm).
- Glänzende, schwarze, durchsichtige oder sehr dünne Objekte erfasst die Tiefenschätzung schlecht.

**Empfohlener Workflow für ein Passteil (z. B. Halter für die Kleiderstange):**
Raum oder Umgebung grob scannen und dabei die *funktionalen Maße antasten* (Stangen-Ø und -Achse, Wandebene, Abstände). Im CAD dient der Scan dann als Referenz-Mesh, die Messungen kommen exakt aus dem CSV bzw. als Zylinder/Ebene im Export.

**Fusion 360**
- **Als Referenz (empfohlen):** *Einfügen → Netz einfügen* mit STL oder OBJ, Einheit **Millimeter**. Das Netz liegt dann als Referenzkörper im Modell, daran kannst du skizzieren, z. B. über *Netz → Schnittskizze erstellen*.
- **STEP:** *Datei → Öffnen* bzw. *Hochladen*. Wird als Flächenkörper mit den Scan-Farben geöffnet. STEP-Limit klein halten (Standard 15 000 Dreiecke), sonst wird Fusion sehr langsam.
- **Volumenkörper aus dem Netz:** *Netz → Reparieren*, dann *Netz → In BRep umwandeln*. Das klappt nur bei geschlossenen Netzen mit wenigen Dreiecken. Für Passteile ist es meist besser, die Geometrie anhand der Messwerte (CSV) neu zu skizzieren.
- Die exportierten **Messungen** (Zylinder für Ø, Platten für Ebenen, Marker für Punkte) liegen exakt an den angetasteten Stellen und eignen sich gut als Bezug für Skizzen.

**Andere CAD-Programme**
- **SolidWorks:** STL öffnen → Optionen „Importieren als: Grafikkörper“ (schnell) oder „Volumenkörper/Flächenkörper“ (nur bei wenigen Dreiecken). STEP geht direkt.
- **FreeCAD:** STEP öffnen (Part-Workbench) oder STL → Mesh-Workbench.
- Bei STEP das Limit „max. Dreiecke“ klein halten (10–30 Tsd.), sonst wird das CAD sehr langsam.

## Fehlersuche

- **„Keine Tiefendaten“:** Quest-Software und Browser aktualisieren und beim Start die Berechtigung für Raumdaten erlauben (Einstellungen → Datenschutz → Raumdaten). Unter „Einstellungen“ auf der Startseite steht nach jeder Sitzung eine **Diagnosezeile** mit den Tiefen-Infos. Bitte schick sie mir, falls etwas nicht klappt.
- **Scan sieht verdoppelt/verzerrt aus:** Unter Einstellungen die *Tiefenbild-Ausrichtung* manuell setzen (normal / gespiegelt).
- **Ruckelt:** Auflösung „Grob“ wählen oder die Vorschau ausschalten.

## Technik

- `js/xr/` – WebXR-Session (`immersive-ar` mit Passthrough), Depth-API-Auslesen (GPU-Pfad: Tiefentextur → Shader → asynchrones PBO-Readback; CPU-Pfad als Fallback), Controller, VR-Menü
- `js/fusion/` – sparse **TSDF**-Volumen (Voxel-Hashing) und Marching Cubes in einem Web Worker, automatische Erkennung der Tiefenbild-Orientierung
- `js/mesh/`, `js/measure.js` – Mesh-Operationen (Taubin, Komponentenfilter, Vertex-Clustering), Kreis-/Ebenen-Fit, Pivot-Kalibrierung
- `js/export/` – STL-, STEP- (mit Flächenfarben), OBJ-, PLY- und CSV-Writer
- `js/xr/color-camera.js` – Kamera per getUserMedia, Kameramodell (FOV, Versatz, Drehung), Zuordnung der Kopfpose zum Aufnahmezeitpunkt
- `js/sim/` – synthetische Tiefenkamera für Simulation und Tests
- `vendor/three/` – three.js r180 (MIT), lokal eingebunden, läuft also auch offline

**Tests:** `npm test` prüft Fusion, Genauigkeit (Kugelradius ±1 mm), Wasserdichtheit, Exporte, Fits, Kalibrierung und Orientierungserkennung. Die STEP-Dateien wurden zusätzlich mit OpenCascade (dem CAD-Kernel von FreeCAD) eingelesen.
