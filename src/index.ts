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
import {
  RemoveBgResult,
  RemoveBgError,
  removeBackgroundFromImageBase64,
} from "remove.bg";
import { Request, Response } from "express";

const kill = require("tree-kill");
var exec = require("child_process").execFile;
let Tail = require("tail").Tail;

var cors = require("cors");
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

let useBGApi: boolean = true; //used during dev. to limit api calls
let skipGenerateGcode: boolean = false; //use the last gcode - used for faster development
const outputDir = `./bgremoved/`;
let removedBgBase64: string = "";

const isLinux: boolean = process.platform === "linux";
console.log("Detected Linux: ", isLinux);

type AppStates =
  | "idle"
  | "removingBg"
  | "processingImage"
  | "rawGcodeReady"
  | "error";

interface StateResponse {
  state: AppStates;
  isDrawing: boolean;
  data?: string;
}

interface GcodeEntry {
  image: string;
  name: string;
}

let appState: AppStates = "idle";
let isDrawing: boolean = false;
let drawingProgress: number = 0;

let currentDrawingProcessPID = 0; //used to stop the process

let httpsServer: any;

checkCertificate();

var whitelist = ["http://192.168.0.52", "http://localhost:4200", undefined];

const corsOptions = {
  origin: function (origin: any, callback: any) {
    if (whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true, //access-control-allow-credentials:true
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

//the checkCertificate function checks if a ssl certifficate can be found on the server snd starts the https server with the cridentials. If no credentials are found it uses a fallback http server
function checkCertificate() {
  /*  try {
    //certificate paths
    const privateKey = fs.readFileSync(
      "/etc/letsencrypt/live/trixamserver.tk/privkey.pem",
      "utf8"
    );
    const certificate = fs.readFileSync(
      "/etc/letsencrypt/live/trixamserver.tk/cert.pem",
      "utf8"
    );
    const ca = fs.readFileSync(
      "/etc/letsencrypt/live/trixamserver.tk/chain.pem",
      "utf8"
    );

    const credentials = {
      key: privateKey,
      cert: certificate,
      ca: ca,
    };
    httpsServer = require("https").createServer(credentials, app);
    console.log("Certificate Found - starting https server");
  } catch {*/
  httpsServer = require("http").createServer(app);
  console.log("No Certificate - starting fallback http server");
  // }
}

app.post("/newPicture", (req: Request, res: Response) => {
  //listen to a /new post request, generate a new gameenviroment and return the new game Id

  if (appState != "idle") {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ err: appState });
  } else {
    appState = "removingBg";
    if (useBGApi && req.body.removeBg) {
      removeBg(req.body.img);
    } else {
      removedBgBase64 = req.body.img;
      fs.writeFile(
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

      convertBase64ToGcode(removedBgBase64);
    }

    fs.writeFile(
      "rawimages/" + Date.now() + "-image.jpeg",
      req.body.img,
      "base64",
      function (err: any, data: any) {
        if (err) {
          console.log("err", err);
        }
        console.log(data, "data");
      }
    );

    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({});
  }
});

app.post("/checkProgress", (req: Request, res: Response) => {
  let response: StateResponse = {
    state: appState,
    isDrawing: isDrawing,
  };
  res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
  res.json(response);
});

app.post("/getGeneratedGcode", (req: Request, res: Response) => {
  if (appState == "rawGcodeReady") {
    let img2gcodePath: string = "./image2gcode/windows/";
    if (isLinux) {
      img2gcodePath = "./image2gcode/linux/";
    }

    let rawGcode = fs.readFileSync(
      img2gcodePath + "gcode/gcode_image.nc",
      "utf8"
    );
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ state: appState, isDrawing: isDrawing, data: rawGcode });
  } else {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ state: appState, err: "no_gcode_ready" });
  }
});

app.post("/getDrawenGcode", (req: Request, res: Response) => {
  if (isDrawing) {
    let rawGcode = fs.readFileSync("gcodes/gcode.nc", "utf8");
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ state: appState, isDrawing: isDrawing, data: rawGcode });
  } else {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ state: appState, err: "not_drawing" });
  }
});

app.post("/getDrawingProgress", (req: Request, res: Response) => {
  if (isDrawing) {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ data: drawingProgress });
  } else {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ err: "not_drawing" });
  }
});

app.post("/postGcode", (req: Request, res: Response) => {
  if (!isDrawing && appState != "error") {
    let gcode: string = req.body.gcode;
    drawGcode(gcode);
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ appState: appState });
  } else {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ appState: appState, err: "not_allowed" });
  }
});

app.post("/cancle", (req: Request, res: Response) => {
  console.log("cancle");
  appState = "idle";
  drawingProgress = 0;
});

app.post("/stop", (req: Request, res: Response) => {
  console.log("stop");
  appState = "idle";
  drawingProgress = 0;
  kill(currentDrawingProcessPID);
  setTimeout(() => {
    exec("./home.sh");
  }, 1000);
});

app.post("/delete", (req: Request, res: Response) => {
  console.log("delete");

  fs.unlink("savedGcodes/" + req.body.id + ".nc", (err: any) => {
    if (err) {
      console.log(err);
      return;
    }
  });
  fs.unlink("savedGcodes/" + req.body.id + ".png", (err: any) => {
    if (err) {
      console.log(err);
      return;
    }
  });
});

app.post("/getGcodeGallery", (req: Request, res: Response) => {
  let gallery: GcodeEntry[] = [];

  fs.readdirSync("savedGcodes/").forEach((file: any) => {
    if (file.includes("png")) {
      let image: string = fs.readFileSync("savedGcodes/" + file, {
        encoding: "base64",
      });
      let entry: GcodeEntry = {
        image: image,
        name: file.split(".")[0],
      };
      gallery.push(entry);
    }
  });

  gallery.reverse();
  if (req.body.range) {
    gallery = gallery.slice(req.body.range[0], req.body.range[1]);
  }

  res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
  res.json({ data: gallery });
});

app.post("/getGcodeById", (req: Request, res: Response) => {
  fs.readFile(
    "savedGcodes/" + req.body.id + ".nc",
    "utf8",
    (err: any, data: string) => {
      res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
      if (err) {
        log(err);
        console.log(err);
        res.json({ err: "not_found" });
        return;
      }
      res.json({ data: data });
    }
  );
});

httpsServer!.listen(3001, () => {
  console.log("listening on *:3001");
});

function drawGcode(gcode: string) {
  fs.writeFile(
    "gcodes/gcode.nc",
    gcode,
    "utf8",
    function (err: any, data: any) {
      if (err) {
        console.log("err", err);
      }

      if (isLinux) {
        let startTime = new Date().getTime();
        let launchcommand: string = "./launchGcodeCli.sh";

        isDrawing = true;

        let tail = new Tail("gcodeCliOutput.txt", "\n", {}, true);

        tail.on("line", function (data: any) {
          data = data.trim();
          drawingProgress = parseInt(data.replace(/[^\d].*/, ""));
          console.log(drawingProgress);
        });

        tail.on("error", function (error: any) {
          log(error);
          console.log("ERROR: ", error);
          isDrawing = false;
        });

        const launchProcess = exec(
          launchcommand,
          function (err: any, data: any) {
            console.log(err);
            console.log(data.toString());

            isDrawing = false;
            if (!err) {
              let timeDiff: number = new Date().getTime() - startTime;
              let lines: number =
                gcode.length - gcode.replace(/\n/g, "").length + 1;

              fs.writeFile(
                "drawingTimesLog.txt",
                lines + "," + timeDiff + "\n",
                { flag: "a" },
                (err: any) => {
                  if (err) console.log(err);
                }
              );

              appState = "idle";
              drawingProgress = 0;
            } else {
              log(err);
              //appState = "error";
            }
          }
        );

        currentDrawingProcessPID = launchProcess.pid;
      } else {
        console.log("Drawing only works on Linux");
      }
    }
  );
}

function removeBg(base64img: any) {
  const outputFile = outputDir + "bgremoved-current.jpg";

  removeBackgroundFromImageBase64({
    base64img,
    apiKey: "ZM746RyfN9PG1uzZT1u5Jqaq",
    size: "preview",
    type: "person",
    format: "jpg",
    scale: "100%",
    bg_color: "fff",
    outputFile,
  })
    .then((result: RemoveBgResult) => {
      console.log(`File saved to ${outputFile}`);
      const rmbgbase64img = result.base64img;
      removedBgBase64 = rmbgbase64img;
      fs.writeFile(
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

      convertBase64ToGcode(removedBgBase64);
    })
    .catch((errors: Array<RemoveBgError>) => {
      log(JSON.stringify(errors));
      console.log(JSON.stringify(errors));
    });
}

function convertBase64ToGcode(base64: string) {
  appState = "processingImage";
  let img2gcodePath: string = "./image2gcode/windows/";
  if (isLinux) {
    img2gcodePath = "./image2gcode/linux/";
  }

  fs.writeFile(
    img2gcodePath + "data/input/image.jpg",
    base64,
    "base64",
    function (err: any, data: any) {
      if (err) {
        log(err);
        console.log("err", err);
      }

      //fs.unlinkSync(img2gcodePath + "gcode/gcode_image.nc");  //needs try catch

      let launchcommand: string = "launchimage2gcode.bat";

      if (isLinux) {
        launchcommand = "./launchimage2gcode.sh";
      }

      if (!skipGenerateGcode) {
        exec(launchcommand, function (err: any, data: any) {
          console.log(err);
          console.log(data.toString());

          if (!err) {
            let img2gcodePath: string = "./image2gcode/windows/";
            if (isLinux) {
              img2gcodePath = "./image2gcode/linux/";
            }

            let fName = Date.now();

            fs.copyFile(
              img2gcodePath + "gcode/gcode_image.nc",
              "savedGcodes/" + fName + ".nc",
              (err: any) => {
                if (err) {
                  log(err);
                  console.log("Error Found:", err);
                } else {
                }
              }
            );

            fs.copyFile(
              img2gcodePath + "gcode/render.png",
              "savedGcodes/" + fName + ".png",
              (err: any) => {
                if (err) {
                  console.log("Error Found:", err);
                } else {
                }
              }
            );

            appState = "rawGcodeReady";
          }
        });
      } else {
        appState = "rawGcodeReady";
      }
    }
  );
}

function log(message: string) {
  fs.writeFile(
    "log.txt",
    new Date().toISOString() + ": " + message + "\n \n",
    { flag: "a" },
    (err: any) => {
      if (err) console.log(err);
    }
  );
}
