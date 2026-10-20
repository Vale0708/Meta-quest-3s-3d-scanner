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
- **Messwerkzeuge mit der Controllerspitze:** Punkt, Abstand, **Kreis/Ø** (z. B. Kleiderstange: 3+ Punkte rundherum → Durchmesser + Achse) und **Ebene** (z. B. Wand, Tischplatte). Das Controller-Tracking ist deutlich genauer als die Tiefenkamera, darum ist das der Weg für exakte Maße.
- **Spitzen-Kalibrierung** (Pivot-Kalibrierung, wie bei Messarmen): Der Messpunkt sitzt danach auf ~1 mm genau an der Controllerspitze.
- **Export** in Millimetern, Z nach oben:
  - **STL** (binär): Standard für Mesh-Import und 3D-Druck
  - **STEP** (AP214, facettierte Flächen): öffnet sich als Flächenkörper im CAD, automatisch auf max. N Dreiecke reduziert
  - **OBJ** mit getrennten Objekten (Scan / Raum-Mesh / Messungen)
  - **CSV-Messprotokoll** (Excel-tauglich, deutsches Format)
- **Aufbereitung beim Export:** Glätten (Taubin, ohne Schrumpfen), Rauschinseln entfernen, Tischauflage abschneiden, **Raum automatisch an den Wänden ausrichten** (Wände parallel zu X/Y).
- Scans werden **auf der Quest gespeichert** (IndexedDB) und können später erneut mit anderen Einstellungen exportiert werden.
- **Simulation:** Am PC lässt sich ohne Brille alles durchspielen.

## Starten

WebXR braucht **https://**. Drei Möglichkeiten, von einfach bis „ohne GitHub“:

### A) GitHub Pages (empfohlen, einmal einrichten)
1. Repo auf GitHub → **Settings → Pages → Source: „GitHub Actions“**.
   *Bei einem privaten Repo geht Pages nur mit GitHub Pro. Alternativ das Repo öffentlich machen (es enthält keine persönlichen Daten).*
2. Nach dem nächsten Push auf `main` läuft der Workflow „Pages“ und die App ist unter `https://vale0708.github.io/Meta-quest-3s-3d-scanner/` erreichbar.
3. URL im Quest-Browser öffnen (Tipp: als Lesezeichen speichern).

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
2. Die gelbe Box hängt an der roten Spitze. Spitze **neben dem Objekt auf die Tischplatte** halten und Trigger drücken: Die Box steht jetzt auf dem Tisch. Mit dem Stick die Größe anpassen, das Objekt muss ganz drin sein.
3. **A** drücken, dann langsam um das Objekt herumgehen und es auch schräg von oben ansehen. In den ersten Sekunden den Kopf einmal hoch/runter und links/rechts bewegen: Die App kalibriert dabei automatisch die Ausrichtung des Tiefenbilds.
4. Wenn die Vorschau geschlossen aussieht: **Fertig & Speichern**. Danach öffnet sich auf der Startseite der Export.

**Ablauf Raum-Scan**
1. Vorher in den Quest-Einstellungen einen **Raum einrichten** (Space Setup). Dann liefert die Quest zusätzlich ihr eigenes Raum-Mesh mit. Alternativ in der App auf „Raum-Setup“ tippen.
2. In der Raummitte starten, **A**, dann langsam alle Wände, Ecken, Boden und Decke abschauen, für Details auch näher rangehen.
3. Wichtige Maße zusätzlich mit dem **Messwerkzeug** antasten, z. B. Kleiderstange mit *Kreis/Ø* (3–6 Punkte rundherum, dann „Messung fertig“) und die Wandhalter mit *Punkt*.

**Koordinatensystem im Export:** Millimeter, Z oben. Bei Objekten liegt der Nullpunkt in der Mitte der Box-Unterseite (also auf der Tischplatte). Beim Raum liegt er auf dem Boden unter der Startposition, und die Achsen sind auf Wunsch parallel zu den Wänden.

**Dateien auf den PC bringen:** Exporte landen im Download-Ordner der Quest. Wege von dort auf den PC:
- USB-Kabel: Quest erscheint als Laufwerk → `Download`
- im Quest-Browser bei Google Drive/OneDrive hochladen

## Was ist realistisch? (ehrliche Einordnung)

Die Quest 3S hat **keinen** Tiefensensor (ToF). Die Tiefe wird aus den Tracking-Kameras geschätzt (Meta Depth API): niedrige Auflösung, Rauschen im **Zentimeterbereich**. Das Mitteln über viele Bilder (TSDF-Fusion) glättet das deutlich, aber:

- **Räume und Möbel:** gut brauchbar. Wände, Nischen, Möbelpositionen und Raumhöhe sollten auf ~1–2 cm stimmen (am echten Gerät noch nicht nachgemessen).
- **Mittelgroße Objekte:** Form und Hüllmaße gut, feine Details (< 2 cm) verschwinden.
- **Kleine Objekte:** grobe Form. Für Passteile reicht das meist nicht. Dafür ist das **Antasten mit der Controllerspitze** da (kalibriert ~1–2 mm).
- Glänzende, schwarze, durchsichtige oder sehr dünne Objekte erfasst die Tiefenschätzung schlecht.

**Empfohlener Workflow für ein Passteil (z. B. Halter für die Kleiderstange):**
Raum oder Umgebung grob scannen und dabei die *funktionalen Maße antasten* (Stangen-Ø und -Achse, Wandebene, Abstände). Im CAD dient der Scan dann als Referenz-Mesh, die Messungen kommen exakt aus dem CSV bzw. als Zylinder/Ebene im Export.

**CAD-Import-Tipps**
- **Fusion 360:** Einfügen → Netz einfügen (STL/OBJ). STEP wird als Flächenkörper geöffnet. Für Volumenkörper: Netz → In BRep umwandeln (bei wenigen Dreiecken).
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
- `js/export/` – STL-, STEP-, OBJ- und CSV-Writer
- `js/sim/` – synthetische Tiefenkamera für Simulation und Tests
- `vendor/three/` – three.js r180 (MIT), lokal eingebunden, läuft also auch offline

**Tests:** `npm test` prüft Fusion, Genauigkeit (Kugelradius ±1 mm), Wasserdichtheit, Exporte, Fits, Kalibrierung und Orientierungserkennung. Die STEP-Dateien wurden zusätzlich mit OpenCascade (dem CAD-Kernel von FreeCAD) eingelesen.
