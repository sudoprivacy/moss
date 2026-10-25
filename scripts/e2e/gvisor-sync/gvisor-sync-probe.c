#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void report(const char *operation, int fd, int data_only) {
    errno = 0;
    int result = data_only ? fdatasync(fd) : fsync(fd);
    int error = result < 0 ? errno : 0;
    printf("{\"operation\":\"%s\",\"result\":%d,\"errno\":%d}\n", operation, result, error);
    fflush(stdout);
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    char path[4096];
    int length = snprintf(path, sizeof(path), "%s/probe-file", argv[1]);
    if (length < 0 || (size_t)length >= sizeof(path)) return 3;
    int writer = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
    if (writer < 0) { perror("open writer"); return 4; }
    const char bytes[] = "host sync error must reach the application";
    if (write(writer, bytes, sizeof(bytes)) != sizeof(bytes)) return 5;
    report("file-write-fsync", writer, 0);
    report("file-write-fdatasync", writer, 1);
    int reader = open(path, O_RDONLY);
    if (reader < 0) { perror("open reader"); return 6; }
    report("file-read-fsync", reader, 0);
    length = snprintf(path, sizeof(path), "%s/existing-readonly-file", argv[1]);
    if (length < 0 || (size_t)length >= sizeof(path)) return 8;
    int existing = open(path, O_RDONLY);
    if (existing < 0) { perror("open existing reader"); return 9; }
    report("existing-file-read-fsync", existing, 0);
    int directory = open(argv[1], O_RDONLY | O_DIRECTORY);
    if (directory < 0) { perror("open directory"); return 7; }
    report("directory-read-fsync", directory, 0);
    close(directory);
    close(existing);
    close(reader);
    close(writer);
    return 0;
}
