import { ethers } from "hardhat"

async function main() {
    const testnetDeployAddr = "0x9e9dfaccabeecda6dd913b3685c9fe908f28f58c"

    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const usdc = await tokenFactory.deploy("TestUSDC", "TestUSDC")
    console.log("USDC deployed to:", usdc.address)

    await usdc.setMinter(testnetDeployAddr)
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
