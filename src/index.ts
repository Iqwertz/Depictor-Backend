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

var exec = require("child_process").execFile;

var cors = require("cors");
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

let useBGApi: boolean = false; //used during dev. to limit api calls
const outputDir = `./bgremoved/`;
let removedBgBase64: string = "";

let isLinux: boolean = true;

type AppStates =
  | "idle"
  | "removingBg"
  | "processingImage"
  | "rawGcodeReady"
  | "Drawing";

let appState: AppStates = "idle";

let httpsServer: any;

checkCertificate();

const corsOptions = {
  origin: "http://localhost:4200",
  credentials: true, //access-control-allow-credentials:true
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

//the checkCertificate function checks if a ssl certifficate can be found on the server snd starts the https server with the cridentials. If no credentials are found it uses a fallback http server
function checkCertificate() {
  try {
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
  } catch {
    httpsServer = require("http").createServer(app);
    console.log("No Certificate - starting fallback http server");
  }
}

app.post("/newPicture", (req: Request, res: Response) => {
  //listen to a /new post request, generate a new gameenviroment and return the new game Id

  if (appState != "idle") {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ err: appState });
  } else {
    appState = "removingBg";
    if (useBGApi) {
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
    res.json({ appState: appState, rawGcode: rawGcode });
  } else {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ appState: appState });
  }
});

app.post("/postGcode", (req: Request, res: Response) => {
  if (appState == "rawGcodeReady") {
    let gcode: string = req.body.gcode;
    drawGcode(gcode);
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ appState: appState });
  } else {
    res.header("Access-Control-Allow-Origin", [req.headers.origin!]);
    res.json({ appState: appState, err: "not_allowed" });
  }
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
        let launchcommand: string =
          "./launchGcodeCli.sh";
        exec(launchcommand, function (err: any, data: any) {
          console.log(err);
          console.log(data.toString());

          if (!err) {
            appState = "Drawing";
          }
        });
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
          }
          console.log(data, "data");
        }
      );

      convertBase64ToGcode(removedBgBase64);
    })
    .catch((errors: Array<RemoveBgError>) => {
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
        console.log("err", err);
      }

      //fs.unlinkSync(img2gcodePath + "gcode/gcode_image.nc");  //needs try catch

      let launchcommand: string = "launchimage2gcode.bat";

      if (isLinux) {
        launchcommand = "./launchimage2gcode.sh";
      }
      exec(launchcommand, function (err: any, data: any) {
        console.log(err);
        console.log(data.toString());

        if (!err) {
          appState = "rawGcodeReady";
        }
      });
    }
  );
}
