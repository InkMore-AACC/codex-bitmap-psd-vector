param([ValidateSet('Both','Photoshop','Illustrator')][string]$App='Both')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$evidenceRoot=Join-Path $projectRoot 'docs\evidence\adobe'
New-Item -ItemType Directory -Force $evidenceRoot | Out-Null
$runStamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$runDir=Join-Path $evidenceRoot $runStamp
New-Item -ItemType Directory -Force $runDir | Out-Null
$jsDirectory=($runDir.Replace('\','/') | ConvertTo-Json -Compress)
$jsonUtility=@'
function encode(o) {
 if (o===null) return 'null';
 if (typeof o=='string') return '"'+o.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';
 if (typeof o=='number'||typeof o=='boolean') return String(o);
 var a=[],k;
 if (o instanceof Array) {for(k=0;k<o.length;k++)a.push(encode(o[k]));return '['+a.join(',')+']';}
 for(k in o) if(o.hasOwnProperty(k)) a.push(encode(k)+':'+encode(o[k]));
 return '{'+a.join(',')+'}';
}
'@
$photoshop=@'
(function(){
var directory=__DIRECTORY__, previousDialogs=app.displayDialogs;
var previousDocument=app.documents.length ? app.activeDocument : null;
var beforeCount=app.documents.length, own=null, output={application:'Photoshop',version:app.version,documentsBefore:beforeCount};
function c(s){return charIDToTypeID(s);} function s(v){return stringIDToTypeID(v);}
try {
 app.displayDialogs=DialogModes.NO;
 own=app.documents.add(UnitValue(480,'px'),UnitValue(320,'px'),72,'LayerCanvas-Isolated-PS-Smoke',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
 own.activeLayer.name='Artwork';
 var purple=new SolidColor();purple.rgb.red=105;purple.rgb.green=72;purple.rgb.blue=190;
 own.selection.select([[20,20],[460,20],[460,300],[20,300]]);own.selection.fill(purple);own.selection.deselect();
 var title=own.artLayers.add();title.name='Editable title';title.kind=LayerKind.TEXT;
 title.textItem.contents='Editable Layers';title.textItem.size=UnitValue(32,'pt');title.textItem.position=[UnitValue(55,'px'),UnitValue(150,'px')];
 try{title.textItem.font='ArialMT';}catch(fontError){}
 var white=new SolidColor();white.rgb.red=255;white.rgb.green=255;white.rgb.blue=255;title.textItem.color=white;
 title.textItem.warpStyle=WarpStyle.ARC;title.textItem.warpBend=15;
 var set=new ActionDescriptor(),ref=new ActionReference();
 ref.putProperty(c('Prpr'),c('Lefx'));ref.putEnumerated(c('Lyr '),c('Ordn'),c('Trgt'));set.putReference(c('null'),ref);
 var effects=new ActionDescriptor();effects.putUnitDouble(c('Scl '),c('#Prc'),100);
 var shadow=new ActionDescriptor();shadow.putBoolean(c('enab'),true);shadow.putBoolean(s('present'),true);shadow.putBoolean(s('showInDialog'),true);
 shadow.putEnumerated(c('Md  '),c('BlnM'),c('Mltp'));
 var black=new ActionDescriptor();black.putDouble(c('Rd  '),0);black.putDouble(c('Grn '),0);black.putDouble(c('Bl  '),0);shadow.putObject(c('Clr '),c('RGBC'),black);
 shadow.putUnitDouble(c('Opct'),c('#Prc'),65);shadow.putBoolean(c('uglg'),false);shadow.putUnitDouble(c('lagl'),c('#Ang'),135);
 shadow.putUnitDouble(c('Dstn'),c('#Pxl'),7);shadow.putUnitDouble(c('Ckmt'),c('#Pxl'),0);shadow.putUnitDouble(c('blur'),c('#Pxl'),10);
 effects.putObject(c('DrSh'),c('DrSh'),shadow);set.putObject(c('T   '),c('Lefx'),effects);executeAction(c('setd'),set,DialogModes.NO);
 var file=new File(directory+'/native-layers.psd');if(file.exists)throw new Error('Refuse overwrite');
 var options=new PhotoshopSaveOptions();options.layers=true;options.embedColorProfile=true;options.alphaChannels=true;
 own.saveAs(file,options,true,Extension.LOWERCASE);
 own.saveAs(new File(directory+'/native-layers-preview.png'),new PNGSaveOptions(),true,Extension.LOWERCASE);
 own.close(SaveOptions.DONOTSAVECHANGES);own=null;
 own=app.open(file);output.layerCount=own.layers.length;output.layers=[];
 for(var i=0;i<own.layers.length;i++){var layer=own.layers[i];output.layers.push({name:layer.name,kind:String(layer.kind)});}
 var reopened=own.artLayers.getByName('Editable title');own.activeLayer=reopened;
 output.text=reopened.textItem.contents;output.font=reopened.textItem.font;output.textEditable=(reopened.kind==LayerKind.TEXT);output.warpStyle=String(reopened.textItem.warpStyle);output.warpBend=reopened.textItem.warpBend;
 var fxRef=new ActionReference();fxRef.putProperty(c('Prpr'),c('Lefx'));fxRef.putEnumerated(c('Lyr '),c('Ordn'),c('Trgt'));
 var fx=executeActionGet(fxRef).getObjectValue(c('Lefx'));output.nativeDropShadow=fx.hasKey(c('DrSh'));
 reopened.textItem.contents='EDIT TEST';output.editRoundTrip=(reopened.textItem.contents=='EDIT TEST');
 output.file=file.fsName;output.ok=output.layerCount==2&&output.textEditable&&output.editRoundTrip&&output.nativeDropShadow;
}catch(e){output.ok=false;output.error=String(e);output.line=e.line;}
finally{if(own){try{own.close(SaveOptions.DONOTSAVECHANGES);}catch(closeError){output.closeError=String(closeError);}} app.displayDialogs=previousDialogs;if(previousDocument){try{app.activeDocument=previousDocument;}catch(restoreError){}}}
output.documentsAfter=app.documents.length;output.dialogsRestored=(app.displayDialogs==previousDialogs);return encode(output);
})();
'@
$illustrator=@'
(function(){
var directory=__DIRECTORY__,previousInteraction=app.userInteractionLevel;
var previousDocument=app.documents.length?app.activeDocument:null;
var beforeCount=app.documents.length,own=null,output={application:'Illustrator',version:app.version,documentsBefore:beforeCount};
try{
 app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;
 own=app.documents.add(DocumentColorSpace.RGB,480,320);own.layers[0].name='Vector artwork';
 var shape=own.layers[0].pathItems.rectangle(290,25,430,260);shape.stroked=false;var purple=new RGBColor();purple.red=105;purple.green=72;purple.blue=190;shape.fillColor=purple;
 var circle=own.layers[0].pathItems.ellipse(280,330,90,90);circle.stroked=false;var gold=new RGBColor();gold.red=255;gold.green=196;gold.blue=70;circle.fillColor=gold;
 var textLayer=own.layers.add();textLayer.name='Editable title';var title=textLayer.textFrames.add();title.contents='Editable Vector';title.position=[55,170];title.textRange.characterAttributes.size=32;
 var white=new RGBColor();white.red=255;white.green=255;white.blue=255;title.textRange.characterAttributes.fillColor=white;
 try{title.textRange.characterAttributes.textFont=app.textFonts.getByName('ArialMT');}catch(fontError){}
 var file=new File(directory+'/native-vectors.ai');if(file.exists)throw new Error('Refuse overwrite');
 var options=new IllustratorSaveOptions();options.pdfCompatible=true;options.compressed=true;own.saveAs(file,options);
 var svg=new File(directory+'/native-vectors.svg'),svgOptions=new ExportOptionsSVG();svgOptions.embedRasterImages=false;svgOptions.preserveEditability=true;own.exportFile(svg,ExportType.SVG,svgOptions);
 var pngOptions=new ExportOptionsPNG24();pngOptions.artBoardClipping=true;pngOptions.transparency=true;own.exportFile(new File(directory+'/native-vectors-preview.png'),ExportType.PNG24,pngOptions);
 own.close(SaveOptions.DONOTSAVECHANGES);own=null;own=app.open(file);
 output.layerCount=own.layers.length;output.pathCount=own.pathItems.length;output.textCount=own.textFrames.length;output.layers=[];
 for(var i=0;i<own.layers.length;i++)output.layers.push(own.layers[i].name);
 output.text=own.textFrames[0].contents;output.font=own.textFrames[0].textRange.characterAttributes.textFont.name;
 own.textFrames[0].contents='EDIT TEST';output.editRoundTrip=(own.textFrames[0].contents=='EDIT TEST');output.file=file.fsName;output.svg=svg.fsName;
 output.ok=output.layerCount==2&&output.pathCount==2&&output.textCount==1&&output.editRoundTrip;
}catch(e){output.ok=false;output.error=String(e);output.line=e.line;}
finally{if(own){try{own.close(SaveOptions.DONOTSAVECHANGES);}catch(closeError){output.closeError=String(closeError);}}app.userInteractionLevel=previousInteraction;if(previousDocument){try{previousDocument.activate();}catch(restoreError){}}}
output.documentsAfter=app.documents.length;output.dialogsRestored=(app.userInteractionLevel==previousInteraction);return encode(output);
})();
'@
$results=@()
foreach($target in @('Photoshop','Illustrator')){
 if($App -ne 'Both' -and $App -ne $target){continue}
 $script=if($target -eq 'Photoshop'){$photoshop}else{$illustrator}
 $script=$jsonUtility+"`n"+$script.Replace('__DIRECTORY__',$jsDirectory)
 $scriptPath=Join-Path $runDir ($target.ToLowerInvariant()+'.jsx')
 [IO.File]::WriteAllText($scriptPath,$script,[Text.UTF8Encoding]::new($false))
 $stopwatch=[Diagnostics.Stopwatch]::StartNew()
 $instance=$null
 try{
  Write-Host "Validating $target COM scripting with a new isolated document..."
  $instance=New-Object -ComObject ($target+'.Application')
  $raw=$instance.DoJavaScript($script)
  $record=$raw | ConvertFrom-Json
  $record | Add-Member -NotePropertyName elapsedSeconds -NotePropertyValue ([math]::Round($stopwatch.Elapsed.TotalSeconds,3))
 }catch{
  $record=[PSCustomObject]@{application=$target;ok=$false;error=$_.Exception.Message;elapsedSeconds=[math]::Round($stopwatch.Elapsed.TotalSeconds,3)}
 }finally{if($instance){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($instance)}}
 $results+=$record
 $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir ($target.ToLowerInvariant()+'-result.json')) -Encoding UTF8
 $record | ConvertTo-Json -Depth 10
}
$results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir 'results.json') -Encoding UTF8
Write-Host "Evidence: $runDir"
if(@($results | Where-Object { -not $_.ok }).Count){exit 1}
