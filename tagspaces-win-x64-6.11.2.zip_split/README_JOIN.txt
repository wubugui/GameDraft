分片说明
========
逻辑文件: tagspaces-win-x64-6.11.2.zip
每片约 99 MiB，共 2 片；单片低于 GitHub 100 MiB 限制。

在分片所在目录下，用 CMD 合并为可解压的 zip：
copy /b "tagspaces-win-x64-6.11.2.zip.001"+"tagspaces-win-x64-6.11.2.zip.002" tagspaces-win-x64-6.11.2.zip.restored.zip

在仓库根目录下合并（分片在子目录时）：
copy /b "tagspaces-win-x64-6.11.2.zip_split\tagspaces-win-x64-6.11.2.zip.001"+"tagspaces-win-x64-6.11.2.zip_split\tagspaces-win-x64-6.11.2.zip.002" tagspaces-win-x64-6.11.2.zip.restored.zip

将生成的 restored 文件改回 tagspaces-win-x64-6.11.2.zip 后可用解压工具打开。
