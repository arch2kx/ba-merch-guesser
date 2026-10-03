import pseudodata from "./pseudodata.json";

console.log(pseudodata.baStudentsMerch[0]?.studentName);

// Iterate over data to sample
for (const item of pseudodata.baStudentsMerch) {
  console.log(item.studentName);
}
