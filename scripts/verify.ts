import { run } from "hardhat"

export const verify = async (address: string, args: Array<any>) => {
    console.log("#########################")
    console.log(`# Verifying  Contract --> ${address}`)
    try {
        await run("verify:verify", {
            address,
            constructorArguments: [...args],
        })
        console.log("# Contract verified!")
    } catch (error) {
        if (error.message.toLowerCase().includes("already verified")) {
            console.log("Already verified!")
        } else {
            console.error("## Contract failed to verify --> ", error)
        }
    }

    console.log("#########################")
}
