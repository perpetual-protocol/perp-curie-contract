pragma solidity 0.7.6;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";

contract ClearingHouse is Ownable {
    //
    // events
    //
    event PoolAdded(address base, uint24 feeRatio, address pool);

    //
    // state variables
    //
    IERC20 public immutable quoteToken;
    IERC20 public immutable vQuoteToken;
    IUniswapV3Factory public immutable uniV3Factory;

    mapping(address => bool) public poolMap;

    constructor(
        IERC20 vQuoteTokenParam,
        IERC20 quoteTokenParam,
        IUniswapV3Factory uniV3FactoryParam
    ) {
        vQuoteToken = vQuoteTokenParam;
        quoteToken = quoteTokenParam;
        uniV3Factory = uniV3FactoryParam;
    }

    function addPool(IERC20 baseToken, uint24 feeRatio) external onlyOwner {
        IUniswapV3Pool pool = UniswapV3Broker.getPool(uniV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: pool is not existent in uniV3 factory
        require(address(pool) != address(0), "CH_NEP");
        // CH_EP: pool is existent in ClearingHouse
        require(!poolMap[address(pool)], "CH_EP");

        // update poolMap
        poolMap[address(pool)] = true;

        emit PoolAdded(address(baseToken), feeRatio, address(pool));
    }
}
