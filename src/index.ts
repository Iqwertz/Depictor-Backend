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
import { Request, Response } from "express";
import { Socket } from "socket.io";

var cors = require("cors");
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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
  console.log(req.body);

  fs.writeFile(
    "images/lastImage.jpeg",
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
});

httpsServer!.listen(3001, () => {
  console.log("listening on *:3001");
});
