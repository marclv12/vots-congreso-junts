# Visor votacions Congreso · XV legislatura

Visor web simple per saber ràpidament:

- qui ha votat què;
- quantes vegades ha votat **Sí / No / Abstenció / No vota** cada diputat;
- recompte per grup parlamentari;
- cercador per diputat, grup, data o títol de la iniciativa;
- exportació CSV del filtre actiu.

La font és l'Open Data del Congreso de los Diputados, apartat **Votaciones**, XV legislatura.

## Ús sense instal·lar Python

### 1. Crear repositori a GitHub

1. Ves a GitHub.
2. Crea un repositori nou, per exemple: `visor-votacions-congreso`.
3. Marca'l com a **Public** o **Private**, com vulguis.

### 2. Pujar els fitxers

1. Descomprimeix aquest ZIP.
2. Entra al repositori de GitHub.
3. Clica **Add file → Upload files**.
4. Arrossega **tots els fitxers i carpetes** del paquet.
5. Clica **Commit changes**.

### 3. Executar la càrrega de dades

1. Ves a la pestanya **Actions**.
2. Obre **Actualitza dades Congreso**.
3. Clica **Run workflow**.
4. Deixa `Rebaixar tota la legislatura? = true`.
5. Clica el botó verd **Run workflow**.

Quan acabi, el repositori tindrà `data/votacions.json` amb totes les votacions detectades.

### 4. Activar GitHub Pages

1. Ves a **Settings → Pages**.
2. A **Build and deployment**, selecciona:
   - Source: **Deploy from a branch**
   - Branch: **main**
   - Folder: **/root**
3. Desa.

GitHub et donarà una URL del tipus:

`https://EL_TEU_USUARI.github.io/visor-votacions-congreso/`

## Actualitzar més endavant

La càrrega s'executa automàticament de dilluns a divendres. També pots forçar-la manualment:

**Actions → Actualitza dades Congreso → Run workflow**

Si vols només les darreres setmanes, posa `false`.

## Important

El fitxer inicial `data/votacions.json` és només una mostra perquè el visor s'obri des del primer moment. La càrrega real completa la fa GitHub Actions.

## Versió 2: dades partides per mesos

Aquesta versió evita el límit de GitHub de 100 MB per fitxer. En comptes de crear un únic `data/votacions.json`, genera:

```text
visor_congreso_github/data/manifest.json
visor_congreso_github/data/chunks/votacions_2023_09.json
visor_congreso_github/data/chunks/votacions_2023_10.json
...
```

El visor carrega automàticament el manifest i tots els fitxers mensuals.
