// import { expect } from "chai"
// import { ethers } from "hardhat"
// import { Sample } from "../typechain"

// describe("sample", () => {
//     it("sample test", async () => {
//         const Sample = await ethers.getContractFactory("Sample")
//         const sample = (await Sample.deploy()) as Sample

//         await sample.deployed()
//         const prev = await sample.c()
//         expect(prev.toString()).eq("0")
//         const tx = await sample.test(5, 2)
//         await tx.wait()
//         const now = await sample.c()
//         expect(now.toString()).eq("7")
//     })
// })
