{
	"translatorID": "0a3d926d-467c-4162-acb6-45bded77edbb",
	"label": "BibTex Citation Keys",
	"creator": "Emiliano heyns",
	"target": "bib",
	"minVersion": "2.1.9",
	"maxVersion": "",
	"priority": 100,
  "configOptions": {
    "getCollections": "true"
  },
  "displayOptions": {},
	"inRepository": true,
	"translatorType": 2,
	"browserSupport": "gcsv",
	"lastUpdated": "/*= timestamp =*/"
}

/*= include BibTeX.js =*/

function doExport() {
  CiteKeys.initialize();
  Zotero.write(JSON.stringify(CiteKeys.items));
}

var exports = {
	"doExport": doExport,
	"setKeywordDelimRe": setKeywordDelimRe,
	"setKeywordSplitOnSpace": setKeywordSplitOnSpace
}

/*= include testcases.js =*/
