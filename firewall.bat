@echo off
rem Run this once as administrator if your phone cannot open the page.
rem It allows incoming connections to ApOffSend on ports 8080-8090.
netsh advfirewall firewall add rule name="ApOffSend" dir=in action=allow protocol=TCP localport=8080-8090 profile=any
pause
