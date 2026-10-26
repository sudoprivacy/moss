#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "sandbox") && strcmp(argv[1], "container"))) return 10;
  char file[128], release[128], text[128];
  snprintf(file, sizeof(file), "/data/%s-committed", argv[1]);
  snprintf(release, sizeof(release), "/data/%s-release", argv[1]);
  int length = snprintf(text, sizeof(text), "MOSS_SHIM_%s_OK\n", argv[1]);
  int fd = open(file, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0 || write(fd, text, length) != length || fsync(fd) || close(fd)) return 11;
  fd = open("/data", O_RDONLY | O_DIRECTORY);
  if (fd < 0 || fsync(fd) || close(fd)) return 12;
  if (write(STDOUT_FILENO, text, length) != length || write(STDERR_FILENO, text, length) != length) return 14;
  for (int i = 0; i < 900; i++) {
    if (access(release, F_OK) == 0) return 0;
    usleep(100000);
  }
  return 13;
}
