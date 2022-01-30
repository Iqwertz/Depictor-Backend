///////////////////////////////////////////////////
//
//selfieDrawer Backend
//
//description: ...
//
//author: Julius Hussl
//repo: ...
//
///////////////////////////////////////////////////

//imports
const express = require("express");
const fs = require("fs");
const fse = require("fs-extra");
import {
  RemoveBgResult,
  RemoveBgError,
  removeBackgroundFromImageBase64,
} from "remove.bg";
import { Request, Response } from "express";
import { enviroment } from "./enviroment";

const kill = require("tree-kill");
var exec = require("child_process").execFile;
let Tail = require("tail").Tail;

var cors = require("cors");
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

let useBGApi: boolean = enviroment.removeBGSettings.enableApi; //used during dev. to limit api calls
let isBGRemoveAPIKey: boolean = false;
let skipGenerateGcode: boolean = enviroment.skipGenerateGcode; //use the last gcode - used for faster development
const outputDir = `./data/bgremoved/`;
let removedBgBase64: string = "";

const isLinux: boolean = process.platform === "linux";
console.log("Detected Linux: ", isLinux);

type AppStates =
  | "idle"
  | "removingBg"
  | "processingImage"
  | "rawGcodeReady"
  | "error"; //possible states of the server

interface StateResponse {
  state: AppStates;
  isDrawing: boolean;
  removeBG: boolean;
}

interface GcodeEntry {
  image: string;
  name: string;
} //reponse interface when sending a gallery item

let appState: AppStates = "idle"; //var to track the current appstate
let isDrawing: boolean = false; //var to track if the bot is currently drawing
let drawingProgress: number = 0; //var to track the progress of the current drawing

let currentDrawingProcessPID: number = 0; //used to stop the drawing process

let httpServer: any;

app.use(cors()); //enable cors

httpServer = require("http").createServer(app); //create new http server

/*
post: /newPicture

description: when the post request is made with an valid request body the picture will be converted to gcode and saved to the library

expected request: 
  {
    removeBg: boolean //use removeBg to removeBackground
    img: string //an base64 encoded picture
  }
  
returns: 
  unsuccessfull: 
    {
      err: string [errMessage]
    }
  successfull:
    {}
*/
app.post("/newPicture", (req: Request, res: Response) => {
  if (appState != "idle") {
    //check if maschine is ready
    res.json({ err: "not_ready: " + appState }); //return error if not
  } else {
    appState = "removingBg"; //update appState
    if (useBGApi && req.body.removeBg) {
      //check if removeBG API should be used
      removeBg(req.body.img); //remove background with removebg //this function will call convertBase64ToGcode asynchronous
    } else {
      removedBgBase64 = req.body.img; //set the removedBgBase64 Image without bgremove
      fse.outputFile(
        //update the current picture
        outputDir + "bgremoved-current.jpg",
        req.body.img,
        "base64",
        function (err: any, data: any) {
          if (err) {
            console.log("err", err);
          }
          console.log(data, "data");
        }
      );

      convertBase64ToGcode(removedBgBase64); //convert the image to gcode
    }

    fse.outputFile(
      //Log file to rawImages folder
      "data/rawimages/" + Date.now() + "-image.jpeg",
      req.body.img,
      "base64",
      function (err: any, data: any) {
        if (err) {
          console.log("err", err);
        }
        console.log(data, "data");
      }
    );

    res.json({}); //return emmpty on success
  }
});

/*
post: /checkProgress

description: returns the current state of the application

expected request: 
  {}
  
returns: 
  @StateResponse
*/
app.post("/checkProgress", (req: Request, res: Response) => {
  checkBGremoveAPIkey();

  let response: StateResponse = {
    state: appState,
    isDrawing: isDrawing,
    removeBG: isBGRemoveAPIKey && useBGApi,
  };

  res.json(response);
});

/*
post: /getGeneratedGcode

description: returns the generated gcode when available

expected request: 
  {}
  
returns: 
  unsuccessfull: 
    {
      state: AppStates, 
      err: string [errMessage]
    }
  successfull:
    {
      state: AppStates, 
      isDrawing: boolean, 
      data: string [requested Gcode]
    }
*/
app.post("/getGeneratedGcode", (req: Request, res: Response) => {
  if (appState == "rawGcodeReady") {
    //check if gcode is ready
    /////get the correct path depending on os
    let img2gcodePath: string = "./data/image2gcode/windows/";
    if (isLinux) {
      img2gcodePath = "./data/image2gcode/linux/";
    }

    /////read gcode
    let rawGcode = fs.readFileSync(
      img2gcodePath + "gcode/gcode_image.nc",
      "utf8"
    );

    res.json({ state: appState, isDrawing: isDrawing, data: rawGcode }); //return gcode and appstate information
  } else {
    res.json({ state: appState, err: "no_gcode_ready" }); //return nogcodeready error when nothing is ready
  }
});

/*
post: /getDrawenGcode

description: returns the currently drawen gcode when available

expected request: 
  {}
  
returns: 
  unsuccessfull: 
    {
      state: AppStates, 
      err: string [errMessage]
    }
   successfull:
    {
      state: AppStates, 
      isDrawing: boolean, 
      data: string [requested Gcode]
    }
*/
app.post("/getDrawenGcode", (req: Request, res: Response) => {
  if (isDrawing) {
    //check if maschine is drawing
    let rawGcode = fs.readFileSync("data/gcodes/gcode.nc", "utf8"); //read gcode

    res.json({ state: appState, isDrawing: isDrawing, data: rawGcode }); //return gcode and appstate information
  } else {
    res.json({ state: appState, err: "not_drawing" }); //return not drawing error
  }
});

/*
post: /getDrawingProgress

description: returns the progress of the current drawing as the amount of gcode lines that where executed

expected request: 
  {}
  
returns: 
  unsuccessfull: 
    {
      err: string [errMessage]
    }
   successfull:
    {
      data: number [amount of gcode lines]
    }
*/
app.post("/getDrawingProgress", (req: Request, res: Response) => {
  if (isDrawing) {
    //check if drawing
    res.json({ data: drawingProgress }); //return progress
  } else {
    res.json({ err: "not_drawing" }); //return notdrawing error
  }
});

/*
post: /postGcode

description: when a valid request is made and the maschine is ready to draw the maschine will start to draw the posted gcode

expected request: 
  {
    gcode: string
  }
  
returns: 
  unsuccessfull: 
    {
      appState: appState
      err: string [errMessage]
    }
   successfull:
    {
      appState: appState
    }
*/
app.post("/postGcode", (req: Request, res: Response) => {
  if (!isDrawing && appState != "error") {
    //check if maschine is not drawing and maschine is ready
    let gcode: string = req.body.gcode;
    drawGcode(gcode); //draw gcode

    res.json({ appState: appState });
  } else {
    res.json({ appState: appState, err: "not_allowed" }); //return notallowed error
  }
});

/*
post: /cancle

description: cancles the generated gcode by updateing appState

expected request: 
  {}
returns: 
  {}
*/
app.post("/cancle", (req: Request, res: Response) => {
  console.log("cancle");
  appState = "idle";
  drawingProgress = 0;
});

/*
post: /stop

description: stops the current drawing process and homes maschine 

expected request: 
  {}
  
returns: 
  {}
*/
app.post("/stop", (req: Request, res: Response) => {
  console.log("stop");
  appState = "idle"; //reset appState
  drawingProgress = 0; //reset drawing progress
  kill(currentDrawingProcessPID); //kill the drawing process
  setTimeout(() => {
    //Home after some timeout because kill() needs some time
    exec("./scripts/home.sh", function (err: any, data: any) {
      console.log(err);
      console.log(data);
    });
  }, 2000);
});

/*
post: /delete

description: deletes an gallery entry by Id

expected request: 
  {
    id: number
  }
  
returns: 
  {}
*/
app.post("/delete", (req: Request, res: Response) => {
  console.log("delete");

  fs.unlink("data/savedGcodes/" + req.body.id + ".nc", (err: any) => {
    //delete gcode
    if (err) {
      console.log(err);
      return;
    }
  });
  fs.unlink("data/savedGcodes/" + req.body.id + ".png", (err: any) => {
    //delete preview image
    if (err) {
      console.log(err);
      return;
    }
  });
});

/*
post: /getGcodeGallery

description: get entrys from gcode gallery. A range can be specified to enable infinite scroll. If no range is defined all entries will be returned

expected request: 
  {
    range?: number[start, end]
  }
  
returns: 
  unsuccessfull: 
    undefined
   successfull:
    {
      data: GcodeEntry[]
    }
*/
app.post("/getGcodeGallery", (req: Request, res: Response) => {
  let gallery: GcodeEntry[] = [];

  fs.readdirSync("data/savedGcodes/").forEach((file: any) => {
    //read all saved gcode files
    if (file.includes("png")) {
      let image: string = fs.readFileSync("data/savedGcodes/" + file, {
        encoding: "base64",
      }); //read preview image as base64 string
      let entry: GcodeEntry = {
        //create entry
        image: image,
        name: file.split(".")[0],
      };
      gallery.push(entry); //push entry to gallery array
    }
  });

  gallery.reverse(); //reverse gallery to show newest first
  if (req.body.range) {
    // check if a range was defined
    gallery = gallery.slice(req.body.range[0], req.body.range[1]); //remove all elements out of defined range
  }

  res.json({ data: gallery }); //return gallery
});

/*
post: /getGcodeById

description: return the requested gcode file by its name(id)

expected request: 
  {
    id: number|string
  }
  
returns: 
  unsuccessfull: 
    {
      err: string [errMessage]
    }
   successfull:
    {
      data: string
    }
*/
app.post("/getGcodeById", (req: Request, res: Response) => {
  fs.readFile(
    //try to read gcode file
    "data/savedGcodes/" + req.body.id + ".nc",
    "utf8",
    (err: any, data: string) => {
      if (err) {
        //check for error
        log(err);
        console.log(err);
        res.json({ err: "not_found" }); //return notfound error when no file was found
        return;
      }
      res.json({ data: data }); //when a gcode file was found return it
    }
  );
});

/*
post: /setBGRemoveAPIKey

description: sets the removeBG Api key by writing it to removeBGAPIKey.txt

expected request: 
  {
    key: string
  }
  
returns: 
  {}
*/
app.post("/setBGRemoveAPIKey", (req: Request, res: Response) => {
  fse.outputFile(
    "removeBGAPIKey.txt",
    req.body.key,
    "utf8",
    function (err: any, data: any) {
      if (err) {
        console.log("err", err);
        log(err);
      }
    }
  );

  res.json({});
});

httpServer!.listen(enviroment.port, () => {
  //start http server
  console.log("listening on *:" + enviroment.port);
});

/**
 *drawGcode()
 * starts a process to draw the given gcode.
 * only draws when run on linux
 * the drawing programm is defined in "launchGcodeCli.sh"
 *
 * @param {string} gcode the gcode th draw
 */
function drawGcode(gcode: string) {
  fse.outputFile(
    //save the gcode file //this file will be used by the gcodesender
    "data/gcodes/gcode.nc",
    gcode,
    "utf8",
    function (err: any, data: any) {
      if (err) {
        //guard clause for errors
        console.log("err", err);
        return;
      }

      if (isLinux) {
        //check if os is Linux
        let startTime = new Date().getTime(); //save start time
        let launchcommand: string = "./scripts/launchGcodeCli.sh"; //command to launch the programm

        isDrawing = true; //update maschine drawing state

        let tail = new Tail("data/logs/gcodeCliOutput.txt", "\n", {}, true); //setup tail to listen to gcode sender output

        tail.on("line", function (data: any) {
          //update progress when a new line is drawen
          data = data.trim();
          drawingProgress = parseInt(data.replace(/[^\d].*/, ""));
        });

        tail.on("error", function (error: any) {
          //stop drawing when an error occured
          log(error);
          console.log("ERROR: ", error);
          isDrawing = false;
        });

        const launchProcess = exec(
          //execute launchcommand
          launchcommand,
          function (err: any, data: any) {
            //after process exits
            console.log(err); //log errors
            console.log(data.toString());

            isDrawing = false; //update drawing state
            if (!err) {
              //when exited with out errors log the printing time and amount of lines to drawingTimesLog.txt. This file is used to determin an time/line estimation for the fronted
              let timeDiff: number = new Date().getTime() - startTime;
              let lines: number =
                gcode.length - gcode.replace(/\n/g, "").length + 1;

              fse.outputFile(
                "data/logs/drawingTimesLog.txt",
                lines + "," + timeDiff + "\n",
                { flag: "a" },
                (err: any) => {
                  if (err) console.log(err);
                }
              );

              //reset appstate and drawing progress
              appState = "idle";
              drawingProgress = 0;
            } else {
              log(err);
              //appState = "error";
            }
          }
        );

        currentDrawingProcessPID = launchProcess.pid; //set the currentProcessId
      } else {
        console.log("Drawing only works on Linux");
      }
    }
  );
}

/**
 *removeBg()
 * uses the removeBg api (https://www.remove.bg/de/tools-api) to remove the background of a picture and start to convert the picture to gcode when succesfull
 * todo: handle error when image bg couldnt be converted
 *
 * @param {string} base64img
 */
function removeBg(base64img: string) {
  const outputFile = outputDir + "bgremoved-current.jpg"; //define the output file

  checkBGremoveAPIkey();
  if (!isBGRemoveAPIKey) {
    return;
  }
  const apiKey = fs.readFileSync("removeBGAPIKey.txt", "utf8");

  removeBackgroundFromImageBase64({
    //send to api with settings
    base64img,
    apiKey: apiKey,
    size: "preview",
    type: enviroment.removeBGSettings.type,
    format: "jpg",
    scale: enviroment.removeBGSettings.scale,
    bg_color: "fff",
    outputFile,
  })
    .then((result: RemoveBgResult) => {
      //api response
      console.log(`File saved to ${outputFile}`);
      const rmbgbase64img = result.base64img;
      removedBgBase64 = rmbgbase64img;
      fse.outputFile(
        //save image
        outputDir + Date.now() + "-bgremoved.jpg",
        rmbgbase64img,
        "base64",
        function (err: any, data: any) {
          if (err) {
            console.log("err", err);
            log(err);
          }
          console.log(data, "data");
        }
      );

      convertBase64ToGcode(removedBgBase64); //convert image to gcode
    })
    .catch((errors: Array<RemoveBgError>) => {
      log(JSON.stringify(errors)); //log errors
      console.log(JSON.stringify(errors));
    });
}

/**
 *convertBase64ToGcode()
 *
 * converts an base64image to gcode with an java based image to gcode converter. It is based on this project: https://github.com/Scott-Cooper/Drawbot_image_to_gcode_v2.
 * @param {string} base64
 */
function convertBase64ToGcode(base64: string) {
	console.log("start convert");
  appState = "processingImage"; //update appState

  /////set basepath based on os
  let img2gcodePath: string = "./data/image2gcode/windows/";
  if (isLinux) {
    img2gcodePath = "data/image2gcode/linux/";
  }

  fse.outputFile(
    //save file to input folder of the convert
    img2gcodePath + "data/input/image.jpg",
    base64,
    "base64",
    function (err: any, data: any) {
      if (err) {
        log(err);
        console.log("err", err);
      }

      //fs.unlinkSync(img2gcodePath + "gcode/gcode_image.nc");  //needs try catch

      //set launchcommand based on os
      let launchcommand: string = "scripts\\launchimage2gcode.bat";
      if (isLinux) {
        launchcommand = "./scripts/launchimage2gcode.sh";
      }

      if (!skipGenerateGcode) {
        //skip generate process (used during dev to skip long processing time)
        console.log("lauching i2g");
	exec(
          launchcommand,

          function (err: any, data: any) {
            //launch converter
		log(err);
            console.log(err);
            console.log(data.toString());

            if (!err) {
              //check for errors

              let fName = Date.now(); //genarate a filename by using current time

              fs.copyFile(
                //save the generated gcode to the gcode folder
                img2gcodePath + "gcode/gcode_image.nc",
                "data/savedGcodes/" + fName + ".nc",
                (err: any) => {
                  if (err) {
                    log(err);
                    console.log("Error Found:", err);
                  } else {
                  }
                }
              );

              fs.copyFile(
                //save the generated preview image to the gcode folder
                img2gcodePath + "gcode/render.png",
                "data/savedGcodes/" + fName + ".png",
                (err: any) => {
                  if (err) {
                    console.log("Error Found:", err);
                  } else {
                  }
                }
              );

              appState = "rawGcodeReady"; //update appState
            }
          }
        );
      } else {
        appState = "rawGcodeReady"; //update appState
      }
    }
  );
}

function checkBGremoveAPIkey() {
  if (!fs.existsSync("removeBGAPIKey.txt")) {
    isBGRemoveAPIKey = false;
  } else {
    isBGRemoveAPIKey = true;
  }
}

/**
 *log a messag to log.txt
 *
 * @param {string} message
 */
function log(message: string) {
  fse.outputFile(
    "data/logs/log.txt",
    new Date().toISOString() + ": " + message + "\n \n",
    { flag: "a" },
    (err: any) => {
      if (err) console.log(err);
    }
  );
}
