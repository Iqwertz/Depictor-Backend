#!/bin/bash

echo starting Depictor install

echo updating system
sudo apt-get update -y
sudo apt-get upgrade -y

echo installing Apache server
sudo apt-get install apache2 -y
echo downloading latest Depictor Frontend Build
sudo rm /var/www/html/index.html
sudo wget "https://github.com/Iqwertz/Depictor/releases/latest/download/Depictor-Build.zip" -O "/var/www/html/latest.zip"
sudo unzip /var/www/html/latest.zip -d /var/www/html/
sudo rm /var/www/html/latest.zip

echo installing XVFB
sudo apt-get install xvfb libxrender1 libxtst6 libxi6 -y
echo installing Java
sudo apt-get install default-jre -y

echo starting Depictor Backend install

echo installing node
curl -sL https://deb.nodesource.com/setup_16.x | sudo bash -
sudo apt-get install -y nodejs
echo installing git
sudo apt install git -y

echo downloading latest Depictor Backend releases
LOCATION=$(curl -s https://api.github.com/repos/Iqwertz/Depictor-Backend/releases/latest \
| grep "tag_name" \
| awk '{print "https://github.com/Iqwertz/Depictor-Backend/archive/" substr($2, 2, length($2)-3) ".zip"}') \
; curl -L -o depictorbackend.zip $LOCATION
unzip depictorbackend.zip
rm depictorbackend.zip
cd Depictor-Backend-*
mv * ../
cd ../
rm -r Depictor-Backend-*
echo installing Node modules
npm i

echo chmodExecutables
sudo chmod +x chmodScripts.sh
sudo ./chmodScripts.sh

echo installing PM2
sudo npm install pm2 -g
echo configuring PM2 startup
pm2 startup | awk '$1 ~ /^sudo/' | bash
echo starting node server
pm2 start "sudo npm run start"
pm2 save

echo finished install