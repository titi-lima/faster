import java.io.*;
import java.lang.instrument.*;
import java.security.ProtectionDomain;
import java.util.concurrent.atomic.AtomicInteger;
import org.objectweb.asm.*;
import org.objectweb.asm.commons.AdviceAdapter;
import org.jacoco.agent.rt.RT;

/** Surefire suite boundaries only; JaCoCo instruments the application code. */
public class ScopeAgent {
  static File output;
  static AtomicInteger sequence = new AtomicInteger();
  static InheritableThreadLocal<Integer> initializationDepth = new InheritableThreadLocal<Integer>() {
    protected Integer initialValue() { return 0; }
  };
  static java.util.Set<String> initializedMethods = java.util.Collections.synchronizedSet(new java.util.HashSet<String>());
  public static void premain(String args, Instrumentation instrumentation) throws Exception {
    output = new File(args); output.mkdirs();
    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      try (PrintWriter writer = new PrintWriter(new File(output, "initialization-" + java.lang.management.ManagementFactory.getRuntimeMXBean().getName().replace('@','_') + ".tsv"))) {
        synchronized(initializedMethods) { for(String method:initializedMethods) writer.println(method); }
      } catch(Exception e) { throw new RuntimeException(e); }
    }));
    instrumentation.addTransformer(new ClassFileTransformer() {
      public byte[] transform(ClassLoader loader, String name, Class<?> clazz,
          ProtectionDomain domain, byte[] bytes) {
        boolean boundary = name.endsWith("/ForkingRunListener");
        boolean production = name.startsWith("org/apache/commons/") || name.startsWith("com/squareup/javapoet/") || name.startsWith("com/fasterxml/jackson/");
        if (!boundary && !production) return null;
        try {
          ClassReader reader = new ClassReader(bytes);
          ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
          reader.accept(new ClassVisitor(Opcodes.ASM7, writer) {
            public MethodVisitor visitMethod(int access, String method, String desc, String sig, String[] exceptions) {
              MethodVisitor mv = super.visitMethod(access, method, desc, sig, exceptions);
              if(production && (access & (Opcodes.ACC_ABSTRACT|Opcodes.ACC_NATIVE))==0) {
                return new AdviceAdapter(Opcodes.ASM7,mv,access,method,desc) {
                  protected void onMethodEnter() {
                    if(method.equals("<clinit>")) super.visitMethodInsn(Opcodes.INVOKESTATIC,"ScopeAgent","enterInitialization","()V",false);
                    super.visitLdcInsn(name+"\t"+method+desc);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC,"ScopeAgent","initializationHit","(Ljava/lang/String;)V",false);
                  }
                  protected void onMethodExit(int opcode) {
                    if(method.equals("<clinit>")) super.visitMethodInsn(Opcodes.INVOKESTATIC,"ScopeAgent","exitInitialization","()V",false);
                  }
                };
              }
              if (!(method.equals("testSetStarting") || method.equals("testSetCompleted")) || !desc.startsWith("(L")) return mv;
              final String callback = method.equals("testSetStarting") ? "start" : "end";
              return new MethodVisitor(Opcodes.ASM7, mv) {
                public void visitCode() {
                  super.visitCode(); super.visitVarInsn(Opcodes.ALOAD, 1);
                  super.visitMethodInsn(Opcodes.INVOKESTATIC, "ScopeAgent", callback, "(Ljava/lang/Object;)V", false);
                }
              };
            }
          }, ClassReader.EXPAND_FRAMES);
          return writer.toByteArray();
        } catch (Throwable e) {
          try (PrintWriter writer = new PrintWriter(new File(output,"transform-error-"+name.replace('/','_')+".txt"))) { e.printStackTrace(writer); }
          catch(Exception ignored) { e.printStackTrace(); }
          throw new RuntimeException(e);
        }
      }
    });
  }
  public static void enterInitialization() { initializationDepth.set(initializationDepth.get()+1); }
  public static void exitInitialization() { initializationDepth.set(Math.max(0,initializationDepth.get()-1)); }
  public static void initializationHit(String method) {
    if(initializationDepth.get()>0) initializedMethods.add(method);
  }
  static String source(Object report) throws Exception {
    java.lang.reflect.Method method = report.getClass().getMethod("getName");
    method.setAccessible(true); Object value = method.invoke(report);
    if(value==null) {
      method = report.getClass().getMethod("getSourceName"); method.setAccessible(true); value=method.invoke(report);
    }
    return String.valueOf(value);
  }
  static synchronized void dump(String name) {
    try {
      byte[] data = RT.getAgent().getExecutionData(true);
      File file = new File(output, name + "--" + java.lang.management.ManagementFactory.getRuntimeMXBean().getName().replace('@','_') + "--" + sequence.getAndIncrement() + ".exec");
      try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(data); }
    } catch (Throwable e) { throw new RuntimeException("Coverage boundary failed", e); }
  }
  public static void start(Object report) { dump("__GLOBAL__"); }
  public static void end(Object report) {
    try { dump(source(report)); } catch (Exception e) { throw new RuntimeException(e); }
  }
}
