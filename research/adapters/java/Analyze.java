import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import org.objectweb.asm.util.*;
import org.jacoco.core.analysis.*;
import org.jacoco.core.tools.ExecFileLoader;

public class Analyze {
  static String hash(String text) throws Exception {
    byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8"));
    StringBuilder out = new StringBuilder(); for(byte b:bytes) out.append(String.format("%02x", b)); return out.toString();
  }
  static String trace(ClassNode node) {
    StringWriter sw = new StringWriter(); node.accept(new TraceClassVisitor(new PrintWriter(sw))); return sw.toString();
  }
  public static void main(String[] args) throws Exception {
    List<File> classes = new ArrayList<>();
    for (String root:args[1].split(File.pathSeparator)) {
      Path base = Paths.get(root); if (!Files.exists(base)) continue;
      try (java.util.stream.Stream<Path> paths = Files.walk(base)) {
        paths.filter(p->p.toString().endsWith(".class")).forEach(p->classes.add(p.toFile()));
      }
    }
    if (args[0].equals("model")) {
      for(File file:classes) {
        ClassNode node = new ClassNode(); new ClassReader(Files.readAllBytes(file.toPath())).accept(node, ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);
        for(MethodNode method:node.methods) {
          Textifier text = new Textifier(); method.accept(new TraceMethodVisitor(text)); StringWriter sw = new StringWriter(); text.print(new PrintWriter(sw));
          System.out.println("METHOD\t"+node.name+"\t"+method.name+method.desc+"\t"+hash(sw.toString()));
          method.instructions.clear(); method.tryCatchBlocks.clear(); method.maxLocals=0; method.maxStack=0;
          if(method.localVariables!=null)method.localVariables.clear();
        }
        System.out.println("SHELL\t"+node.name+"\t"+hash(trace(node)));
      }
    } else {
      File[] execs = new File(args[2]).listFiles((dir,name)->name.endsWith(".exec"));
      if(execs==null || execs.length==0) throw new RuntimeException("No per-suite execution data");
      for(File exec:execs) {
        ExecFileLoader loader = new ExecFileLoader(); loader.load(exec); CoverageBuilder builder = new CoverageBuilder();
        Analyzer analyzer = new Analyzer(loader.getExecutionDataStore(), builder);
        for(File file:classes) analyzer.analyzeAll(file);
        String suite=exec.getName().split("--")[0];
        for(IClassCoverage clazz:builder.getClasses()) {
          if(clazz.isNoMatch()) throw new RuntimeException("JaCoCo class identity mismatch "+clazz.getName());
          for(IMethodCoverage method:clazz.getMethods()) if(method.getInstructionCounter().getCoveredCount()>0)
            System.out.println(suite+"\t"+clazz.getName()+"\t"+method.getName()+method.getDesc());
        }
      }
    }
  }
}
