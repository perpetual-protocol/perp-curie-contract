import { ethers } from "hardhat"

async function main() {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const usdc = await tokenFactory.deploy("TestUSDC", "TestUSDC")
    console.log("USDC deployed to:", usdc.address)

    const deployer = ethers.getSigners[0]
    await usdc.setMinter(deployer.address)
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
